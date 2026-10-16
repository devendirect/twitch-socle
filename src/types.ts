/**
 * Types partagés par le socle et les jeux.
 *
 * Un jeu ne voit jamais Twitch : il reçoit des commandes déjà analysées, parle
 * par des clés de messages, et rend une vue. Tout le reste — lecture du chat,
 * nettoyage, file d'envoi, points, base, sécurité HTTP — est ici.
 */

import type { ZodTypeAny } from 'zod';
import type { Clock } from './clock.js';
import type { Scores } from './scores.js';
import type { Store } from './store.js';
import type { LimiteFrequence } from './limites.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

/** Un message du chat, tel que Twitch l'a envoyé, texte déjà nettoyé. */
export interface ChatLine {
  /** Identifiant du message (tag `id`) : c'est lui que vise un `CLEARMSG`. */
  id: string | null;
  /** Tag `user-id`. `null` s'il manque : le message est alors ignoré par le jeu. */
  userId: string | null;
  login: string;
  /** Pseudo affiché, sans caractères invisibles, avec sa casse d'origine. */
  displayName: string;
  channel: string;
  text: string;
  isModerator: boolean;
  isBroadcaster: boolean;
}

/**
 * Ce qu'un modérateur retire du chat.
 *
 *   message      `CLEARMSG` : un message supprimé
 *   utilisateur  `CLEARCHAT` ciblé : bannissement (`dureeSecondes` nul) ou exclusion
 *
 * `CLEARCHAT` sans cible (chat vidé) n'est pas une sanction : il ne produit rien.
 */
export type Retrait =
  | { type: 'message'; messageId: string }
  | { type: 'utilisateur'; userId: string; login: string; dureeSecondes: number | null };

/**
 * État d'authentification, **observé** et non déduit (repris du SNCF).
 *
 *   anonymous     aucun jeton : lecture seule assumée, le jeu reste jouable
 *   pending       jeton envoyé, Twitch n'a pas encore répondu
 *   authenticated Twitch a répondu `GLOBALUSERSTATE` : le bot peut parler
 *   refused       Twitch a refusé le jeton : il ne parlera pas
 */
export type EtatAuth = 'anonymous' | 'pending' | 'authenticated' | 'refused';

/**
 * Connexion au chat. Twitch en IRC aujourd'hui, le simulateur en développement,
 * EventSub peut-être demain : un nouveau transport, et aucun jeu ne change.
 */
export interface ChatTransport {
  /** Login du bot, pour ignorer ses propres messages ; `null` en anonyme. */
  readonly loginBot: string | null;
  readonly etat: EtatAuth;
  readonly connecte: boolean;
  /** Diffuseur, modérateur ou VIP dans le salon : 100 messages / 30 s au lieu de 20. */
  readonly eleve: boolean;
  connecter(): Promise<void>;
  fermer(): Promise<void>;
  /**
   * Envoie UNE ligne, déjà nettoyée et découpée. Seule `sortie.ts` l'appelle :
   * c'est le seul chemin vers le chat.
   */
  envoyer(texte: string): void;
  surMessage(handler: (line: ChatLine) => void): void;
  surRetrait(handler: (retrait: Retrait) => void): void;
}

/** Un spectateur, identifié par son `user-id` Twitch, jamais par son pseudo. */
export interface Joueur {
  userId: string;
  login: string;
  displayName: string;
  /** Streamer ou modérateur, lu dans les badges du message. */
  estModo: boolean;
}

/** Message du chat qui a passé l'entrée (section 5 du brief). */
export interface MessageJoueur {
  id: string | null;
  joueur: Joueur;
  texte: string;
}

/** Commande déjà analysée : `nom` est le nom canonique de la table d'alias. */
export interface Commande {
  nom: string;
  /** Arguments tels que tapés : casse et accents conservés. */
  args: string[];
  joueur: Joueur;
  messageId: string | null;
}

/** Nom canonique → alias acceptés, sans `!`, en minuscules et sans accents. */
export type TableAlias = Readonly<Record<string, readonly string[]>>;

/**
 * Un texte du bot. Plusieurs formulations possibles : la file d'envoi prend la
 * première qui diffère du message précédent (anti-doublon de Twitch).
 */
export type Texte = string | readonly string[];

// Les paramètres varient d'un message à l'autre : le contrôle de forme est
// fait par le test qui compare les clés des deux langues.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Messages = Readonly<Record<string, (p: any) => Texte>>;

export type Langue = 'fr' | 'en';

export type ActionModeration = 'start' | 'stop' | 'skip';

/** Ce qu'un faux spectateur du simulateur répondrait, selon le jeu. */
export interface ProfilSimu<V> {
  /**
   * Réponse d'un faux joueur à cet instant, ou `null` s'il ne dit rien.
   * `aleatoire` est le tirage du simulateur : même graine, même partie.
   */
  reponse(vue: V, aleatoire: () => number, pseudo: string): string | null;
}

/**
 * Panneau propre au jeu, sous `/api/jeu` (mêmes protections que tout `/api/*` :
 * hôte, origine, jeton du panneau).
 *
 *   GET  /api/jeu   `etat(now)` : ce que voit le streamer, réponse comprise ;
 *                   jamais diffusé à l'overlay.
 *   POST /api/jeu   corps validé par `schema` (`.strict()` : champ inconnu → 400),
 *                   puis `executer` ; `{ erreur }` → 409.
 */
export interface PanneauJeu {
  etat(now: Date): unknown;
  schema: ZodTypeAny;
  executer(commande: unknown, now: Date): { erreur?: string } | void;
}

/** Le contrat d'un jeu (section 9 du brief). */
export interface MiniJeu<V> {
  id: string;
  /** Ses commandes, en français et en anglais, ajoutées à celles du socle. */
  commandes: TableAlias;
  /** Ses textes. La clé `aide` est la ligne d'aide de `!aide`. */
  messages: { fr: Messages; en: Messages };
  /** Mention de source, affichée en permanence. */
  attribution: string;
  surCommande(commande: Commande, now: Date): void;
  /** Message qui n'est pas une commande : « 1987 » pour un jeu de devinette. */
  surMessage?(message: MessageJoueur, now: Date): void;
  /** `CLEARMSG`, `CLEARCHAT` ciblé, ou `!oubliemoi` : retirer des réponses en cours. */
  surRetrait(messageIds: string[], userId?: string): void;
  surModeration(action: ActionModeration, now: Date): void;
  /** Appelé chaque seconde : fermer une manche, passer à la suivante. */
  tic?(now: Date): void;
  /** Recalculée à chaque lecture, jamais en cache. */
  vue(now: Date): V;
  profilSimu?: ProfilSimu<V>;
  /** Réglages et état privé pour le panneau du jeu (`/api/jeu`). */
  panneau?: PanneauJeu;
}

export interface OptionsDire {
  /** Faux pour une réponse individuelle : abandonnée la première si la file déborde. */
  essentiel?: boolean;
}

/** Ce que le socle fournit à un jeu. */
export interface OutilsSocle {
  chat: {
    /** Dit le message `cle` (du jeu, sinon du socle) dans la langue choisie. */
    dire(cle: string, parametres?: Record<string, unknown>, options?: OptionsDire): void;
  };
  scores: Scores;
  store: Store;
  clock: Clock;
  logger: Logger;
  limites: { creer(options: { max: number; fenetreMs: number }): LimiteFrequence };
  /** Tirage du socle : déterministe sous le simulateur avec `--graine`. */
  aleatoire: () => number;
  /** Rediffuse la vue aux overlays (appels regroupés). */
  diffuser(): void;
  /**
   * Manches suivies en base, pour qu'un redémarrage en pleine manche se voie :
   * la manche est alors annulée sans points, et le chat prévenu.
   */
  manches: {
    ouvrir(id: string): void;
    fermer(id: string, statut?: 'terminee' | 'annulee'): void;
  };
}

export type FabriqueJeu<V> = (outils: OutilsSocle) => MiniJeu<V>;
