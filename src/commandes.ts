import type { ActionModeration, TableAlias } from './types.js';

/**
 * Commandes du chat, en français et en anglais (section 4 du brief).
 *
 * Une seule table d'alias : le socle y déclare ses commandes, un jeu y
 * **ajoute** les siennes par la même table, jamais par un `switch` à part.
 *
 * Lecture, dans cet ordre (le texte arrive déjà nettoyé par l'entrée) :
 *   1. espaces multiples réduits, espaces de début et de fin retirés ;
 *   2. majuscules ignorées sur le nom : `!Classement`, `!CLASSEMENT` ;
 *   3. accents ignorés sur le **nom** : `!donnees` = `!données`. Jamais sur les
 *      arguments : « Kévin » et « Kevin » sont deux prénoms différents.
 */

export const COMMANDES_SOCLE = {
  points: ['points', 'score', 'solde', 'balance'],
  classement: ['classement', 'top', 'leaderboard'],
  oubli: ['oubliemoi', 'oublie-moi', 'effacemoi', 'efface-moi', 'rgpd', 'forgetme', 'forget-me'],
  donnees: ['donnees', 'data', 'privacy'],
  aide: ['aide', 'help', 'commandes', 'commands'],
  /** `!jeu start` : streamer et modérateurs seulement. */
  moderation: ['jeu', 'game'],
} as const satisfies TableAlias;

/** Arguments de `!jeu …` / `!game …`, sans accents. */
const ACTIONS: Readonly<Record<string, ActionModeration>> = {
  start: 'start',
  demarrer: 'start',
  lancer: 'start',
  stop: 'stop',
  arreter: 'stop',
  skip: 'skip',
  passer: 'skip',
  suivant: 'skip',
};

/** Minuscules, sans accents : pour comparer un nom de commande. */
export function plier(valeur: string): string {
  return valeur.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Index alias → nom canonique. Un alias déclaré deux fois est une erreur de
 * conception : levée au démarrage plutôt qu'une commande qui change de sens
 * selon l'ordre de chargement.
 */
export function indexer(...tables: TableAlias[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const table of tables) {
    for (const [nom, alias] of Object.entries(table)) {
      for (const brut of [nom, ...alias]) {
        const cle = plier(brut);
        const deja = index.get(cle);
        if (deja !== undefined && deja !== nom) {
          throw new Error(`Alias « !${cle} » déclaré pour « ${deja} » et pour « ${nom} ».`);
        }
        index.set(cle, nom);
      }
    }
  }
  return index;
}

export interface CommandeLue {
  nom: string;
  args: string[];
}

/** `null` si le texte n'est pas une commande connue. */
export function analyser(texte: string, index: ReadonlyMap<string, string>): CommandeLue | null {
  const propre = texte.replace(/\s+/gu, ' ').trim();
  if (!propre.startsWith('!')) return null;
  const [tete = '', ...args] = propre.slice(1).split(' ');
  const nom = index.get(plier(tete));
  return nom === undefined ? null : { nom, args };
}

/** Action de `!jeu <action>`, ou `null` si l'argument n'en est pas une. */
export function actionModeration(args: readonly string[]): ActionModeration | null {
  const premier = args[0];
  return premier === undefined ? null : (ACTIONS[plier(premier)] ?? null);
}
