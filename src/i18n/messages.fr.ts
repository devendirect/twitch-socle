import { pseudo } from '../chat/sortie.js';

/**
 * Textes du socle, en français. **Aucun texte du bot n'est écrit ailleurs.**
 *
 * Chaque message commence par un texte fixe ou une mention `@pseudo` : jamais
 * par un texte venu du chat (section 6). Un tableau donne plusieurs
 * formulations, pour l'anti-doublon de Twitch.
 *
 * `messages.en.ts` doit avoir exactement les mêmes clés (test dédié).
 */

export interface LigneClassement {
  nom: string;
  victoires: number;
  points: number;
}

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`;

export const messagesFr = {
  points: (p: { nom: string; points: number; victoires: number }) =>
    `@${pseudo(p.nom)} ${pluriel(p.points, 'point')}, ${pluriel(p.victoires, 'victoire')}.`,

  classement: (p: { lignes: LigneClassement[] }) =>
    `🏆 ${p.lignes
      .map((l, i) => `${i + 1}. ${pseudo(l.nom)} (${pluriel(l.victoires, 'victoire')}, ${l.points} pts)`)
      .join(' · ')}`,

  classementVide: () => ['🏆 Personne au classement pour l’instant.', '🏆 Classement vide : à vous de jouer.'],

  oubli: (p: { nom: string }) => `@${pseudo(p.nom)} c’est fait : tes points, tes victoires et ta réponse en cours sont effacés.`,

  donnees: (p: { nom: string; mois: number }) =>
    `@${pseudo(p.nom)} gardés : ton pseudo, ton identifiant Twitch, tes points et tes victoires — ` +
    `effacés après ${p.mois} mois sans jouer, ou tout de suite avec !oubliemoi. Aucun message du chat n’est enregistré.`,

  aide: (p: { jeu: string }) => `${p.jeu} — aussi : !points, !classement, !donnees, !oubliemoi`,

  mancheInterrompue: () => 'La manche en cours a été interrompue, aucun point n’a été compté.',

  arret: () => ['Le jeu s’arrête, à bientôt.', 'Fin du jeu pour aujourd’hui, à bientôt.'],
};
