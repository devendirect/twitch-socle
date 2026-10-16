/** Points, base et durée de conservation (section 8 du brief). */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Scores } from '../src/scores.js';
import { Store } from '../src/store.js';
import type { Joueur } from '../src/types.js';

const joueur = (userId: string, displayName = userId): Joueur => ({ userId, login: userId, displayName, estModo: false });

const dossiers: string[] = [];
const dossier = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'socle-'));
  dossiers.push(d);
  return d;
};
afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scores', () => {
  it('trie par victoires, puis par points', () => {
    const scores = new Scores();
    scores.award(joueur('riche'), 900);
    scores.award(joueur('gagnant'), 10, { victoire: true });
    scores.award(joueur('moyen'), 50);
    expect(scores.classement().map((p) => p.userId)).toEqual(['gagnant', 'riche', 'moyen']);
  });

  it('forget efface aussi les victoires ; un joueur qui revient repart de zéro', () => {
    const store = new Store();
    const scores = new Scores({ store });
    scores.award(joueur('a'), 80, { victoire: true });
    scores.forget('a');
    expect(scores.get('a')).toBeNull();
    expect(store.loadPlayers()).toEqual([]);

    const retour = scores.award(joueur('a'), 5);
    expect(retour).toMatchObject({ points: 5, wins: 0, played: 1 });
    store.close();
  });

  it('suit le dernier pseudo d’un même user-id', () => {
    const scores = new Scores();
    scores.award(joueur('42', 'Alice'), 10);
    scores.award(joueur('42', 'AliceRenommee'), 10);
    expect(scores.classement()).toHaveLength(1);
    expect(scores.get('42')?.displayName).toBe('AliceRenommee');
  });

  it('écrit chaque changement en base aussitôt', () => {
    const store = new Store();
    new Scores({ store }).award(joueur('a'), 30, { victoire: true });
    expect(new Scores({ store }).get('a')).toMatchObject({ points: 30, wins: 1 });
    store.close();
  });
});

describe('purge', () => {
  it('supprime un joueur inactif depuis plus de PURGE_MOIS mois et garde les autres', () => {
    const store = new Store();
    const ancien = new Scores({ store, now: () => new Date('2025-01-01T00:00:00Z') });
    ancien.award(joueur('ancien'), 10);
    const recent = new Scores({ store, now: () => new Date('2026-10-01T00:00:00Z') });
    recent.award(joueur('recent'), 10);

    expect(store.purgeInactive(new Date('2025-10-15T00:00:00Z'))).toBe(1);
    expect(store.loadPlayers().map((p) => p.userId)).toEqual(['recent']);
    store.close();
  });
});

describe('sauvegarde', () => {
  it('une sauvegarde rouverte sans son fichier -wal contient toutes les données', () => {
    const d = dossier();
    const store = new Store(path.join(d, 'jeu.db'));
    const scores = new Scores({ store });
    for (let i = 0; i < 20; i++) scores.award(joueur(`j${i}`), i, { victoire: i % 3 === 0 });
    store.openRound('m1', 'factice', new Date());

    const sauvegarde = path.join(d, 'sauvegarde', 'jeu.db');
    store.backup(sauvegarde);
    expect(existsSync(`${sauvegarde}-wal`)).toBe(false);

    // Copie du seul fichier principal, ailleurs : aucun -wal ne l'accompagne.
    const copie = path.join(d, 'copie.db');
    copyFileSync(sauvegarde, copie);
    const relue = new Store(copie);
    expect(relue.loadPlayers()).toHaveLength(20);
    expect(relue.roundStatus('m1')).toBe('ouverte');
    relue.close();
    store.close();
  });

  it('refuse d’écraser une sauvegarde existante', () => {
    const d = dossier();
    const store = new Store(path.join(d, 'jeu.db'));
    store.backup(path.join(d, 's.db'));
    expect(() => store.backup(path.join(d, 's.db'))).toThrow(/existe déjà/);
    store.close();
  });
});

describe('réglages', () => {
  it('survivent à la fermeture de la base, et une valeur remplace la précédente', () => {
    const fichier = path.join(dossier(), 'jeu.db');
    const store = new Store(fichier);
    expect(store.lireReglage('theme')).toBeNull();
    store.ecrireReglage('theme', 'plan');
    store.ecrireReglage('theme', 'laiton');
    store.close();

    const relue = new Store(fichier);
    expect(relue.lireReglage('theme')).toBe('laiton');
    expect(relue.lireReglage('autre')).toBeNull();
    relue.close();
  });
});

describe('manches', () => {
  it('au démarrage, une manche restée ouverte passe « interrompue »', () => {
    const store = new Store();
    store.openRound('m1', 'factice', new Date());
    store.openRound('m2', 'factice', new Date());
    store.closeRound('m2', 'terminee', new Date());
    store.openRound('autre', 'prenoms', new Date());

    expect(store.interruptOpenRounds('factice', new Date())).toBe(1);
    expect(store.roundStatus('m1')).toBe('interrompue');
    expect(store.roundStatus('m2')).toBe('terminee');
    expect(store.roundStatus('autre')).toBe('ouverte');
    store.close();
  });
});
