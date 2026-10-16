import type { ChatLine, ChatTransport, EtatAuth, Logger, Retrait } from '../types.js';
import { parseIrcLine, toChatLine, toRetrait } from './irc.js';

/**
 * Connexion au chat Twitch en IRC sur WebSocket (copié de `sncf/src/chat/client.ts`).
 *
 * Deux modes :
 *
 *   - **anonyme** : aucun identifiant, lecture seule. Twitch accepte n'importe
 *     quel pseudo `justinfanNNNNN`. Les tags arrivent quand même (vérifié à
 *     l'essai SNCF du 15/10/2026) : joueurs et badges sont lus.
 *   - **authentifié** : un jeton de bot, et le bot peut répondre.
 *
 * Ce client ne fait que le transport. La file d'envoi, les limites de Twitch,
 * l'anti-doublon et le nettoyage sont dans `sortie.ts` ; le filtrage des
 * messages reçus dans `entree.ts`.
 *
 * `WebSocket` est natif depuis Node 22 : aucune dépendance.
 */

const TWITCH_IRC = 'wss://irc-ws.chat.twitch.tv:443';

/**
 * Twitch ne formule pas le refus d'une seule façon : « Login authentication
 * failed » pour un jeton expiré ou révoqué, « Improperly formatted auth » pour
 * un jeton malformé — typiquement le préfixe `oauth:` oublié. Les deux sont
 * définitifs, et ne pas reconnaître le second laissait le client reboucler.
 */
function isAuthFailure(notice: string | null | undefined): boolean {
  if (!notice) return false;
  const text = notice.toLowerCase();
  return text.includes('authentication failed') || text.includes('improperly formatted auth');
}

export interface ChatClientOptions {
  channel: string;
  /** Jeton `oauth:…` du compte bot. Absent → lecture seule anonyme. */
  token?: string | undefined;
  username?: string | undefined;
  logger?: Logger;
  url?: string;
  /**
   * Fabrique de socket — uniquement pour les tests, qui en fournissent un
   * faux. Sans elle, la connexion au chat serait la seule chose du projet
   * qu'aucun test ne pourrait atteindre.
   */
  createSocket?: (url: string) => WebSocket;
}

/**
 * Dernier message du bot refusé par Twitch : `NOTICE` dont le `msg-id`
 * commence par `msg_` (doublon, débit, bot banni ou exclu, mode followers…).
 * Sans lui, le bot se tait sans que personne ne le sache.
 */
export interface ChatRefusal {
  msgId: string;
  text: string;
  at: string;
}

export class TwitchChatClient implements ChatTransport {
  readonly #options: ChatClientOptions;
  readonly #handlers: Array<(line: ChatLine) => void> = [];
  readonly #retraitHandlers: Array<(retrait: Retrait) => void> = [];
  readonly #log: Logger;

  #socket: WebSocket | null = null;
  #connected = false;
  #closing = false;
  #reconnectAttempt = 0;
  #auth: EtatAuth;
  #lastRefusal: ChatRefusal | null = null;
  /** Diffuseur, modérateur ou VIP dans le salon : lu dans `USERSTATE`. */
  #elevated = false;

  constructor(options: ChatClientOptions) {
    this.#options = options;
    this.#auth = options.token ? 'pending' : 'anonymous';
    this.#log = maskedLogger(options.logger, options.token);
  }

  get loginBot(): string | null {
    return this.#options.token ? (this.#options.username ?? null) : null;
  }

  /** Ce que Twitch a répondu, pas ce qui est configuré. */
  get etat(): EtatAuth {
    return this.#auth;
  }

  get connecte(): boolean {
    return this.#connected;
  }

  get eleve(): boolean {
    return this.#elevated;
  }

  /** Dernier refus d'envoi signalé par Twitch, ou `null`. */
  get lastRefusal(): ChatRefusal | null {
    return this.#lastRefusal;
  }

  surMessage(handler: (line: ChatLine) => void): void {
    this.#handlers.push(handler);
  }

  surRetrait(handler: (retrait: Retrait) => void): void {
    this.#retraitHandlers.push(handler);
  }

  async connecter(): Promise<void> {
    this.#closing = false;
    await this.#open();
  }

  async fermer(): Promise<void> {
    this.#closing = true;
    this.#socket?.close();
    this.#socket = null;
    this.#connected = false;
  }

  /**
   * Une ligne `PRIVMSG`. Ne passe que par `sortie.ts`, qui a déjà retiré
   * `\r`, `\n`, `\0`, découpé, neutralisé `/` et `.`, et respecté les limites.
   */
  envoyer(texte: string): void {
    if (!this.#connected) return;
    this.#socket?.send(`PRIVMSG #${this.#options.channel.toLowerCase()} :${texte}`);
  }

  #open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.#options.url ?? TWITCH_IRC;
      const socket = (this.#options.createSocket ?? ((u: string) => new WebSocket(u)))(url);
      this.#socket = socket;

      socket.addEventListener('open', () => {
        const { username, channel } = this.#options;
        // Un jeton refusé une fois ne sera pas accepté la fois suivante : on
        // se reconnecte en anonyme plutôt que de reboucler sur un refus.
        const token = this.#auth === 'refused' ? undefined : this.#options.token;

        // L'ordre compte : les capacités AVANT l'authentification, sinon
        // Twitch n'envoie pas les tags et on perd user-id et display-name.
        socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');

        if (token) {
          socket.send(`PASS ${token.startsWith('oauth:') ? token : `oauth:${token}`}`);
          socket.send(`NICK ${username ?? 'bot'}`);
        } else {
          // Pseudo anonyme : Twitch accepte n'importe quel justinfanNNNNN.
          socket.send(`NICK justinfan${Math.floor(Math.random() * 90_000) + 10_000}`);
        }

        socket.send(`JOIN #${channel.toLowerCase()}`);

        this.#connected = true;
        this.#reconnectAttempt = 0;
        this.#log.info(`Chat connecté à #${channel}${token ? '' : ' (lecture seule)'}.`);
        resolve();
      });

      socket.addEventListener('message', (event) => {
        for (const line of String(event.data).split('\r\n')) {
          this.#handleLine(line);
        }
      });

      socket.addEventListener('error', () => {
        if (!this.#connected) reject(new Error('Connexion au chat Twitch impossible.'));
      });

      socket.addEventListener('close', () => {
        this.#connected = false;
        if (!this.#closing) this.#scheduleReconnect();
      });
    });
  }

  #handleLine(line: string): void {
    const message = parseIrcLine(line);
    if (!message) return;

    // Twitch coupe une connexion qui ne répond pas au PING.
    if (message.command === 'PING') {
      this.#socket?.send(`PONG :${message.trailing ?? 'tmi.twitch.tv'}`);
      return;
    }

    // Twitch demande de se reconnecter avant une maintenance.
    if (message.command === 'RECONNECT') {
      this.#log.warn('Chat : Twitch demande une reconnexion.');
      this.#socket?.close();
      return;
    }

    /**
     * Le verdict de Twitch, dans les deux sens.
     *
     * `GLOBALUSERSTATE` n'arrive QUE sur une connexion authentifiée : c'est le
     * signal de succès. Sans lui, rien ne distingue « le bot peut parler » de
     * « un jeton est configuré ».
     */
    if (message.command === 'GLOBALUSERSTATE') {
      if (this.#auth !== 'authenticated') {
        this.#auth = 'authenticated';
        this.#log.info(
          `Chat : bot authentifié${message.tags['display-name'] ? ` (${message.tags['display-name']})` : ''}.`,
        );
      }
      return;
    }

    if (message.command === 'USERSTATE') {
      const badges = message.tags['badges'] ?? '';
      this.#elevated =
        message.tags['mod'] === '1' || /(^|,)(broadcaster|moderator|vip)\//.test(badges);
      return;
    }

    if (message.command === 'CLEARCHAT' || message.command === 'CLEARMSG') {
      const retrait = toRetrait(message);
      if (retrait) this.#emit(this.#retraitHandlers, retrait, 'retrait');
      return;
    }

    if (message.command === 'NOTICE' && isAuthFailure(message.trailing)) {
      // Définitif : rejouer le même jeton ne changera rien. On bascule en
      // lecture seule assumée plutôt que de reboucler indéfiniment dessus.
      this.#auth = 'refused';
      this.#log.warn(
        'Chat : jeton refusé par Twitch (expiré, révoqué, ou sans le droit ' +
          'd’écrire). Le bot passe en LECTURE SEULE : le jeu continue, ' +
          'mais il n’annoncera rien. Régénère TWITCH_BOT_TOKEN pour le réactiver.',
      );
      return;
    }

    if (message.command === 'NOTICE') {
      const msgId = message.tags['msg-id'] ?? '';
      if (msgId.startsWith('msg_')) {
        this.#lastRefusal = { msgId, text: message.trailing ?? '', at: new Date().toISOString() };
        this.#log.warn(`Chat : message refusé par Twitch (${msgId}) — ${message.trailing ?? ''}`);
      }
      return;
    }

    const chatLine = toChatLine(message);
    if (chatLine) this.#emit(this.#handlers, chatLine, 'message');
  }

  #emit<T>(handlers: Array<(value: T) => void>, value: T, kind: string): void {
    for (const handler of handlers) {
      try {
        handler(value);
      } catch (error: unknown) {
        // Un message malformé ne doit pas tuer la connexion en plein live.
        this.#log.warn(
          `Chat : gestionnaire de ${kind} en échec — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  #scheduleReconnect(): void {
    const delay = Math.min(30_000, 1000 * 2 ** this.#reconnectAttempt++);
    this.#log.warn(`Chat déconnecté, nouvelle tentative dans ${delay / 1000} s.`);
    setTimeout(() => {
      if (!this.#closing) void this.#open().catch(() => this.#scheduleReconnect());
    }, delay).unref?.();
  }
}

/**
 * Le jeton ne doit apparaître dans aucun journal. Un message d'erreur qui
 * recopierait la commande `PASS`, ou un futur journal de débogage, suffirait :
 * on le masque à la sortie, sous ses deux formes (avec et sans `oauth:`).
 */
export function maskedLogger(logger: Logger | undefined, token: string | undefined): Logger {
  const secrets = token
    ? [...new Set([token, token.replace(/^oauth:/, '')])].filter((secret) => secret.length >= 8)
    : [];
  const mask = (text: string) =>
    secrets.reduce((masked, secret) => masked.split(secret).join('***'), text);
  return {
    info: (message) => logger?.info(mask(message)),
    warn: (message) => logger?.warn(mask(message)),
  };
}
