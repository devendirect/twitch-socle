import { pseudo } from '../chat/sortie.js';
import type { messagesFr, LigneClassement } from './messages.fr.js';

/** Textes du socle, en anglais. Mêmes clés que `messages.fr.ts` (test dédié). */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const messagesEn: { [K in keyof typeof messagesFr]: (typeof messagesFr)[K] } = {
  points: (p: { nom: string; points: number; victoires: number }) =>
    `@${pseudo(p.nom)} ${plural(p.points, 'point')}, ${plural(p.victoires, 'win')}.`,

  classement: (p: { lignes: LigneClassement[] }) =>
    `🏆 ${p.lignes
      .map((l, i) => `${i + 1}. ${pseudo(l.nom)} (${plural(l.victoires, 'win')}, ${l.points} pts)`)
      .join(' · ')}`,

  classementVide: () => ['🏆 Nobody on the leaderboard yet.', '🏆 Empty leaderboard: your turn to play.'],

  oubli: (p: { nom: string }) => `@${pseudo(p.nom)} done: your points, wins and current answer are erased.`,

  donnees: (p: { nom: string; mois: number }) =>
    `@${pseudo(p.nom)} kept: your name, your Twitch ID, your points and wins — ` +
    `erased after ${p.mois} months without playing, or right now with !forgetme. No chat message is stored.`,

  aide: (p: { jeu: string }) => `${p.jeu} — also: !points, !leaderboard, !privacy, !forgetme`,

  mancheInterrompue: () => 'The current round was interrupted, no points were counted.',

  arret: () => ['The game is stopping, see you soon.', 'Game over for today, see you soon.'],
};
