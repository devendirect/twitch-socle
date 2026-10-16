import type { ChatTransport, Logger, OptionsDire, Texte } from '../types.js';
import { cleanChatText } from './irc.js';

/**
 * Sortie : **tout message envoyé passe par là** (section 6 du brief).
 *
 *   1. nettoyage : `\r`, `\n`, `\0` retirés (une ligne de plus serait une
 *      commande IRC émise par le bot) ;
 *   2. découpage à 480 caractères, aux espaces ;
 *   3. `› ` devant un morceau qui commencerait par `/` ou `.` (une commande
 *      Twitch, `/ban` signé du compte du bot s'il est modérateur) ;
 *   4. file bornée, au plus 1 message par seconde et 20 par 30 s (100 si le
 *      bot est diffuseur, modérateur ou VIP) ;
 *   5. anti-doublon : un message identique au précédent dans les 30 s prend
 *      une autre formulation, ou un suffixe discret.
 *
 * Repris du SNCF (`irc.ts` et la file de `client.ts`), où chaque règle a été
 * ajoutée après l'avoir payée. L'horloge et l'attente sont injectables : les
 * limites se vérifient sans attendre 30 s pour de vrai.
 */

/**
 * Limites d'envoi de Twitch, sur une fenêtre glissante de 30 s : 20 messages
 * et 1 par seconde pour un compte ordinaire, 100 pour le diffuseur, un
 * modérateur ou un VIP (https://dev.twitch.tv/docs/chat/, relu le 16/10/2026).
 * Au-delà, Twitch ignore les messages et peut bloquer le compte un moment.
 * L'intervalle d'une seconde est gardé même pour un bot modérateur : il
 * n'en a pas besoin, mais un chat inondé par le bot n'aide personne.
 */
export const FENETRE_MS = 30_000;
export const LIMITE = 20;
export const LIMITE_ELEVEE = 100;

/** Twitch refuse un message identique au précédent pendant 30 s. */
export const DOUBLON_MS = 30_000;

/** Longueur maximale d'un texte du chat cité par le bot. */
export const CITATION_MAX = 40;
/** Longueur maximale d'un pseudo affiché. */
export const PSEUDO_MAX = 25;

export interface SortieOptions {
  transport: ChatTransport;
  logger?: Logger;
  /** Intervalle minimal entre deux messages. */
  intervalleMs?: number;
  /** Messages en attente au plus. */
  maxFile?: number;
  maintenant?: () => number;
  attendre?: (ms: number) => Promise<void>;
}

interface EnAttente {
  variantes: string[];
  essentiel: boolean;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Sortie {
  readonly #transport: ChatTransport;
  readonly #log: Logger | undefined;
  readonly #intervalle: number;
  readonly #max: number;
  readonly #maintenant: () => number;
  readonly #attendre: (ms: number) => Promise<void>;
  readonly #file: EnAttente[] = [];
  /** Heures d'envoi sur la fenêtre glissante. */
  readonly #envoyes: number[] = [];
  #dernier: { texte: string; at: number } | null = null;
  #enCours: Promise<void> | null = null;
  #ferme = false;

  constructor(options: SortieOptions) {
    this.#transport = options.transport;
    this.#log = options.logger;
    this.#intervalle = options.intervalleMs ?? 1000;
    this.#max = options.maxFile ?? 20;
    this.#maintenant = options.maintenant ?? Date.now;
    this.#attendre = options.attendre ?? pause;
  }

  /** Messages en attente d'envoi. */
  get enAttente(): number {
    return this.#file.length;
  }

  /**
   * Met un texte en file. Résolu quand la file est vide.
   *
   * En lecture seule (pas de jeton, ou jeton refusé), le texte est journalisé
   * au lieu d'être envoyé : le jeu reste jouable et observable.
   */
  dire(texte: Texte, options: OptionsDire = {}): Promise<void> {
    const variantes = (typeof texte === 'string' ? [texte] : [...texte]).filter((v) => v.trim() !== '');
    if (variantes.length === 0) return Promise.resolve();

    const etat = this.#transport.etat;
    if (etat === 'anonymous' || etat === 'refused') {
      this.#log?.info(`[chat · lecture seule] ${variantes[0]}`);
      return Promise.resolve();
    }

    const essentiel = options.essentiel ?? true;
    const morceaux = splitForChat(variantes[0]!);
    if (morceaux.length > 1) {
      // Un long message se découpe ; ses variantes n'auraient plus de sens.
      for (const morceau of morceaux) this.#ajouter({ variantes: [morceau], essentiel });
    } else {
      const courtes = variantes.map((v) => splitForChat(v)).filter((m) => m.length === 1).map((m) => m[0]!);
      this.#ajouter({ variantes: courtes, essentiel });
    }
    return this.#vider();
  }

  /** Vide la file sans rien envoyer : arrêt du serveur, après `attendreVide`. */
  fermer(): void {
    this.#ferme = true;
    this.#file.length = 0;
  }

  /** Attend que la file soit vide, au plus `delaiMs` (arrêt du serveur). */
  async attendreVide(delaiMs: number): Promise<void> {
    if (!this.#enCours) return;
    await Promise.race([this.#enCours, pause(delaiMs)]);
  }

  /** File bornée : on sacrifie d'abord les réponses, jamais une annonce. */
  #ajouter(item: EnAttente): void {
    if (this.#file.length >= this.#max) {
      const optionnel = this.#file.findIndex((attente) => !attente.essentiel);
      if (optionnel !== -1) {
        const [abandon] = this.#file.splice(optionnel, 1);
        this.#log?.warn(`Chat : file pleine, réponse abandonnée — ${abandon!.variantes[0]}`);
      } else if (!item.essentiel) {
        this.#log?.warn(`Chat : file pleine, réponse abandonnée — ${item.variantes[0]}`);
        return;
      } else {
        const abandon = this.#file.shift()!;
        this.#log?.warn(`Chat : file pleine, annonce abandonnée — ${abandon.variantes[0]}`);
      }
    }
    this.#file.push(item);
  }

  #vider(): Promise<void> {
    this.#enCours ??= this.#boucle().finally(() => {
      this.#enCours = null;
      // Un message ajouté entre la fin de la boucle et ce nettoyage a trouvé
      // `#enCours` encore posé et n'a rien relancé : il resterait en file
      // jusqu'au message suivant.
      if (this.#file.length > 0 && !this.#ferme) void this.#vider();
    });
    return this.#enCours;
  }

  async #boucle(): Promise<void> {
    while (this.#file.length > 0) {
      await this.#attendrePlace();
      const item = this.#file.shift();
      if (!item) break;
      const texte = this.#choisir(item.variantes);
      this.#transport.envoyer(texte);
      const now = this.#maintenant();
      this.#envoyes.push(now);
      this.#dernier = { texte, at: now };
    }
  }

  /** Attend l'intervalle minimal, puis une place dans la fenêtre de Twitch. */
  async #attendrePlace(): Promise<void> {
    while (!this.#ferme) {
      // Le transport ignore un envoi hors connexion : on attend qu'il revienne
      // plutôt que de perdre l'annonce.
      if (!this.#transport.connecte) {
        await this.#attendre(500);
        continue;
      }
      const now = this.#maintenant();
      while (this.#envoyes.length > 0 && now - this.#envoyes[0]! >= FENETRE_MS) this.#envoyes.shift();

      const depuis = this.#dernier ? now - this.#dernier.at : Infinity;
      if (depuis < this.#intervalle) {
        await this.#attendre(this.#intervalle - depuis);
        continue;
      }
      const limite = this.#transport.eleve ? LIMITE_ELEVEE : LIMITE;
      if (this.#envoyes.length < limite) return;
      await this.#attendre(FENETRE_MS - (now - this.#envoyes[0]!) + 50);
    }
  }

  /**
   * « Manche terminée. » deux fois de suite serait refusé (`msg_duplicate`) :
   * on prend la première formulation qui diffère du dernier envoi, sinon un
   * suffixe discret.
   */
  #choisir(variantes: string[]): string {
    const dernier = this.#dernier;
    if (!dernier || this.#maintenant() - dernier.at >= DOUBLON_MS) return variantes[0]!;
    return variantes.find((v) => v !== dernier.texte) ?? `${variantes[0]} ·`;
  }
}

/** Coupe à `max` caractères (points de code, pas unités UTF-16), avec « … ». */
function couper(texte: string, max: number): string {
  const lettres = [...texte];
  return lettres.length <= max ? texte : `${lettres.slice(0, max - 1).join('')}…`;
}

/**
 * Un texte du chat repris dans une réponse : nettoyé (section 5) et tronqué à
 * 40 caractères, pour qu'un spectateur ne fasse pas dire n'importe quoi au bot.
 */
export function citer(texte: string, max = CITATION_MAX): string {
  return couper(cleanChatText(texte), max);
}

/** Pseudo affiché : nettoyé et tronqué à 25 caractères. */
export function pseudo(nom: string): string {
  return couper(cleanChatText(nom), PSEUDO_MAX);
}

/**
 * Twitch coupe les messages au-delà de 500 caractères. On découpe aux espaces
 * plutôt qu'en plein mot : un podium tronqué à « 🥇 Ali » fait mauvais effet.
 *
 * ⚠️ C'est aussi le goulot par lequel passe TOUT ce que le bot dit, donc
 * l'endroit où retirer les caractères de contrôle.
 *
 * En IRC, `\r\n` termine une commande : un retour à la ligne glissé dans un
 * message transforme la suite en commande émise par le compte du bot. Le texte
 * du chat ne peut pas en contenir — les lignes reçues sont déjà découpées
 * dessus — mais le motif d'annulation, lui, arrive par `POST /api/game/abort`
 * et traversait sans contrôle jusqu'au socket. Avec un bot modérateur, c'était
 * un bannissement signé de ton compte.
 *
 * Le filtre est ici et nulle part ailleurs : un appelant qui oublierait de
 * nettoyer ne peut pas contourner le seul chemin de sortie.
 *
 * (Le paragraphe précédent parle du SNCF : son motif d'annulation passait par
 * l'API. Dans le socle, tout texte passe par `Sortie.dire`.)
 *
 * Même logique pour `/` et `.` en tête de message : Twitch les lit comme une
 * commande (`/ban`, `.timeout`). Aucun message du bot ne commence aujourd'hui
 * par une donnée, mais rien ne l'empêchait — un futur « {gare} est choisie »
 * aurait suffi. Chaque morceau qui commencerait ainsi est préfixé de `› `.
 */
export function splitForChat(message: string, limit = 480): string[] {
  message = String(message ?? '').replace(/[\r\n\0]+/g, ' ');
  return splitWords(message, limit).map(neutralizeCommand);
}

/** `› ` devant un morceau que Twitch prendrait pour une commande. */
function neutralizeCommand(chunk: string): string {
  const trimmed = chunk.trimStart();
  return trimmed.startsWith('/') || trimmed.startsWith('.') ? `› ${trimmed}` : chunk;
}

function splitWords(message: string, limit: number): string[] {
  if ([...message].length <= limit) return [message];

  const chunks: string[] = [];
  let current = '';

  for (const word of message.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if ([...candidate].length > limit && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
