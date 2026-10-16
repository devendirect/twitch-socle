import type { ChatLine, ChatTransport, Logger, MessageJoueur, Retrait } from '../types.js';

/**
 * Entrée : **tout message reçu passe par là** avant d'atteindre un jeu
 * (section 5 du brief).
 *
 * Déjà fait par `irc.ts`, pour chaque ligne : caractères invisibles et de sens
 * d'écriture retirés, NFC, `/me` déplié, pseudo nettoyé. Ici :
 *
 *   - les messages du bot lui-même et des comptes de `BOTS_IGNORES` sont
 *     ignorés : un bot qui répond à un bot boucle, et un bot de chaîne n'est
 *     pas un joueur ;
 *   - un message sans `user-id` est ignoré pour le jeu, avec un avertissement
 *     une seule fois : sans identifiant stable, pas de joueur ;
 *   - un message vide après nettoyage ne va nulle part.
 *
 * Les retraits (`CLEARMSG`, `CLEARCHAT` ciblé) sont transmis tels quels.
 */

export interface EntreeOptions {
  transport: ChatTransport;
  /** Logins ignorés, en minuscules (bots courants compris). */
  botsIgnores: readonly string[];
  logger?: Logger;
}

export class Entree {
  readonly #ignores: Set<string>;
  readonly #log: Logger | undefined;
  readonly #handlers: Array<(message: MessageJoueur) => void> = [];
  readonly #retraitHandlers: Array<(retrait: Retrait) => void> = [];
  #avertiSansId = false;

  constructor(options: EntreeOptions) {
    this.#log = options.logger;
    this.#ignores = new Set(options.botsIgnores.map((login) => login.toLowerCase()));
    const bot = options.transport.loginBot;
    if (bot) this.#ignores.add(bot.toLowerCase());

    options.transport.surMessage((line) => this.#recevoir(line));
    options.transport.surRetrait((retrait) => {
      for (const handler of this.#retraitHandlers) handler(retrait);
    });
  }

  surMessage(handler: (message: MessageJoueur) => void): void {
    this.#handlers.push(handler);
  }

  surRetrait(handler: (retrait: Retrait) => void): void {
    this.#retraitHandlers.push(handler);
  }

  #recevoir(line: ChatLine): void {
    if (this.#ignores.has(line.login.toLowerCase())) return;
    if (!line.text) return;

    if (!line.userId) {
      if (!this.#avertiSansId) {
        this.#avertiSansId = true;
        this.#log?.warn(
          'Chat : message reçu sans user-id, ignoré pour le jeu. Les tags Twitch ' +
            'sont-ils demandés (CAP REQ) ? Avertissement affiché une seule fois.',
        );
      }
      return;
    }

    const message: MessageJoueur = {
      id: line.id,
      joueur: {
        userId: line.userId,
        login: line.login,
        displayName: line.displayName,
        estModo: line.isModerator || line.isBroadcaster,
      },
      texte: line.text,
    };
    for (const handler of this.#handlers) handler(message);
  }
}
