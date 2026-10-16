/**
 * Le vote du chat. Copié du SNCF, où les options étaient des trains : elles
 * gardent ici une charge utile du même genre, pour vérifier qu'elle traverse
 * le vote intacte.
 *
 * Le tirage au sort est injecté : « au hasard » ne doit pas vouloir dire
 * « intestable ». Sans ça, le cas le plus important — personne n'a voté, une
 * partie doit quand même démarrer — ne serait vérifiable qu'en croisant les
 * doigts.
 */

import { describe, expect, it } from 'vitest';
import { RankedVote, type VoteOption } from '../src/vote.js';

interface Train {
  trainNumber: string;
  destination: string;
}

function train(n: string, destination: string): VoteOption<Train> {
  return { title: `TER ${n}`, subtitle: `→ ${destination}`, payload: { trainNumber: n, destination } };
}

const CANDIDATS = [
  train('1001', 'La Rochelle'),
  train('1002', 'Paris Montparnasse'),
  train('1003', 'Agen'),
  train('1004', 'Nantes'),
];

/** Horloge et tirage pilotés : le test décide du temps et du sort. */
function ouvrir(options: { random?: () => number; durationMs?: number } = {}) {
  let instant = new Date('2026-09-20T14:00:00Z');
  const vote = new RankedVote({
    subject: 'train',
    options: CANDIDATS,
    durationMs: options.durationMs ?? 90_000,
    now: () => instant,
    ...(options.random ? { random: options.random } : {}),
  });
  return { vote, avance: (ms: number) => void (instant = new Date(instant.getTime() + ms)) };
}

describe('dépouillement', () => {
  it('désigne le train le plus voté', () => {
    const { vote } = ouvrir();
    vote.cast('a', 2);
    vote.cast('b', 2);
    vote.cast('c', 3);

    const résultat = vote.close();
    expect(résultat.rank).toBe(2);
    expect(résultat.winner.payload.trainNumber).toBe('1002');
    expect(résultat.votes).toBe(2);
    expect(résultat.total).toBe(3);
    expect(résultat.reason).toBe('votes');
  });

  it('compte une personne une fois, même si elle insiste', () => {
    const { vote } = ouvrir();
    vote.cast('a', 1);
    vote.cast('a', 1);
    vote.cast('a', 1);
    expect(vote.total).toBe(1);
    expect(vote.tally()[0]).toBe(1);
  });

  it('laisse changer d’avis, et ne compte que le dernier choix', () => {
    const { vote } = ouvrir();
    expect(vote.cast('a', 1)).toBe('ok');
    expect(vote.cast('a', 4)).toBe('changed');
    expect(vote.tally()).toEqual([0, 0, 0, 1]);
    expect(vote.total).toBe(1);
  });

  it('refuse un rang hors de la liste', () => {
    const { vote } = ouvrir();
    expect(vote.cast('a', 0)).toBe('invalid');
    expect(vote.cast('a', 5)).toBe('invalid');
    expect(vote.cast('a', 1.5)).toBe('invalid');
    expect(vote.total).toBe(0);
  });
});

describe('quand le chat ne tranche pas', () => {
  it('tire au sort si personne n’a voté', () => {
    // Le tirage vise le troisième candidat.
    const { vote } = ouvrir({ random: () => 0.5 });
    const résultat = vote.close();

    expect(résultat.reason).toBe('random');
    expect(résultat.total).toBe(0);
    expect(résultat.rank).toBe(3);
    expect(résultat.winner.payload.trainNumber).toBe('1003');
  });

  it('tire au sort parmi les ex æquo, et le dit', () => {
    const { vote } = ouvrir({ random: () => 0.99 });
    vote.cast('a', 1);
    vote.cast('b', 4);

    const résultat = vote.close();
    expect(résultat.reason).toBe('tie');
    expect(résultat.votes).toBe(1);
    // Le dernier des deux ex æquo, jamais un troisième train sans voix.
    expect(résultat.rank).toBe(4);
  });

  it('ne tire jamais un train qui n’a aucune voix en cas d’égalité', () => {
    for (const tirage of [0, 0.25, 0.5, 0.75, 0.99]) {
      const { vote } = ouvrir({ random: () => tirage });
      vote.cast('a', 2);
      vote.cast('b', 3);
      expect([2, 3]).toContain(vote.close().rank);
    }
  });

  it('désigne toujours un gagnant, quelle que soit la valeur tirée', () => {
    for (const tirage of [0, 0.999999]) {
      const { vote } = ouvrir({ random: () => tirage });
      const résultat = vote.close();
      expect(résultat.winner).toBeDefined();
      expect(résultat.rank).toBeGreaterThanOrEqual(1);
      expect(résultat.rank).toBeLessThanOrEqual(CANDIDATS.length);
    }
  });
});

describe('fenêtre de vote', () => {
  it('se ferme à l’heure dite', () => {
    const { vote, avance } = ouvrir({ durationMs: 90_000 });
    expect(vote.expired()).toBe(false);
    avance(89_000);
    expect(vote.expired()).toBe(false);
    avance(2_000);
    expect(vote.expired()).toBe(true);
  });

  it('n’accepte plus de voix une fois le temps écoulé', () => {
    const { vote, avance } = ouvrir({ durationMs: 10_000 });
    avance(11_000);
    expect(vote.cast('a', 1)).toBe('closed');
    expect(vote.total).toBe(0);
  });

  it('n’accepte plus de voix après clôture, même avant l’heure', () => {
    const { vote } = ouvrir();
    vote.close();
    expect(vote.cast('a', 1)).toBe('closed');
  });

  it('décompte les secondes restantes pour l’affichage', () => {
    const { vote, avance } = ouvrir({ durationMs: 90_000 });
    expect(vote.view().secondsLeft).toBe(90);
    avance(30_000);
    expect(vote.view().secondsLeft).toBe(60);
    avance(90_000);
    expect(vote.view().secondsLeft).toBe(0);
  });
});

describe('vue diffusée', () => {
  it('donne les parts, et zéro avant le premier vote', () => {
    const { vote } = ouvrir();
    expect(vote.view().candidates.every((c) => c.share === 0)).toBe(true);

    vote.cast('a', 1);
    vote.cast('b', 1);
    vote.cast('c', 2);

    const vue = vote.view();
    expect(vue.total).toBe(3);
    expect(vue.candidates[0]?.votes).toBe(2);
    expect(vue.candidates[0]?.share).toBeCloseTo(2 / 3);
    expect(vue.candidates[1]?.share).toBeCloseTo(1 / 3);
    expect(vue.candidates[3]?.share).toBe(0);
  });

  it('numérote les candidats comme le chat les voit', () => {
    const { vote } = ouvrir();
    expect(vote.view().candidates.map((c) => c.rank)).toEqual([1, 2, 3, 4]);
  });

  it('refuse d’ouvrir un vote sans candidat', () => {
    expect(() => new RankedVote({ subject: 'train', options: [], durationMs: 1000 })).toThrow();
  });
});
