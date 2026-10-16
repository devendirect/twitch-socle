/**
 * Tests d'ensemble : le jeu factice branché sur le socle, joué par le
 * simulateur, par le même chemin qu'en direct (entrée, commandes, jeu,
 * sortie, base). Section 14 du brief, « Ensemble », « Commandes », « Entrée ».
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demarrerJeu } from '../src/demarrer.js';
import { Simulateur, TransportSimule, mulberry32, userIdDe } from '../src/simu.js';
import type { Clock } from '../src/clock.js';
import { jeuFactice } from './jeu-factice.js';

const silencieux = { info: () => {}, warn: () => {} };

function horloge(depart = '2026-10-16T18:00:00Z') {
  let t = Date.parse(depart);
  const clock: Clock = { now: () => new Date(t), describe: () => 'horloge de test' };
  return { clock, avancer: (ms: number) => void (t += ms) };
}

async function monter(options: { env?: Record<string, string>; graine?: number; transport?: TransportSimule } = {}) {
  const { clock, avancer } = horloge();
  const transport = options.transport ?? new TransportSimule();
  const socle = await demarrerJeu(jeuFactice, {
    env: { DB_PATH: ':memory:', ...options.env },
    transport,
    clock,
    aleatoire: mulberry32((options.graine ?? 1) + 1),
    logger: silencieux,
    ecouter: false,
    ticMs: null,
    sortie: { intervalleMs: 0 },
  });
  /** Laisse partir les messages en file. */
  const envoyes = async () => {
    await socle.sortie.attendreVide(1000);
    return transport.envoyes;
  };
  return { socle, transport, clock, avancer, envoyes };
}

const dossiers: string[] = [];
afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('une partie complète, simulée', () => {
  async function partie(graine: number) {
    const { socle, transport, clock, avancer } = await monter({ graine });
    const simulateur = new Simulateur({ transport, joueurs: 25, graine, profil: socle.jeu.profilSimu, vue: () => socle.jeu.vue(clock.now()) });
    transport.injecter('streamer', '!jeu start', { diffuseur: true });
    for (let seconde = 0; seconde < 120; seconde++) {
      simulateur.pas();
      avancer(1000);
      socle.tic();
    }
    const classement = socle.outils.scores.classement(5).map((p) => [p.displayName, p.wins, p.points]);
    const texteEnBase = socle.outils.store.allText();
    await socle.arreter();
    return { classement, texteEnBase, envoyes: transport.envoyes };
  }

  it('même graine, même classement', async () => {
    const a = await partie(42);
    const b = await partie(42);
    expect(a.classement.length).toBeGreaterThan(0);
    expect(b.classement).toEqual(a.classement);
  });

  it('le bot annonce, donne les résultats et dit au revoir', async () => {
    const { envoyes } = await partie(7);
    expect(envoyes.some((m) => m.startsWith('🔢'))).toBe(true);
    expect(envoyes.some((m) => m.startsWith('🏁'))).toBe(true);
    expect(envoyes.at(-1)).toMatch(/à bientôt/);
  });

  it('aucun texte de message n’est écrit en base', async () => {
    const { texteEnBase } = await partie(3);
    for (const bavardage of ['trop bien ce jeu', 'salut tout le monde', 'gg', '!points']) {
      expect(texteEnBase).not.toContain(bavardage);
    }
  });
});

describe('commandes communes', () => {
  it('!points, !classement, !donnees, !aide répondent', async () => {
    const { socle, transport, avancer, envoyes } = await monter();
    transport.injecter('alice', '!points');
    transport.injecter('alice', '!classement');
    transport.injecter('alice', '!données');
    transport.injecter('alice', '!help');
    const lignes = await envoyes();
    expect(lignes[0]).toBe('@alice 0 point, 0 victoire.');
    expect(lignes[1]).toMatch(/Personne au classement|Classement vide/);
    expect(lignes[2]).toMatch(/12 mois/);
    expect(lignes[3]).toMatch(/^Tapez un nombre de 1 à 100 — aussi : !points/);
    avancer(1);
    await socle.arreter();
  });

  it('une même personne n’obtient qu’une réponse par commande toutes les 10 s', async () => {
    const { socle, transport, avancer, envoyes } = await monter();
    for (let i = 0; i < 5; i++) transport.injecter('alice', '!points');
    expect(await envoyes()).toHaveLength(1);
    avancer(10_000);
    transport.injecter('alice', '!points');
    expect(await envoyes()).toHaveLength(2);
    await socle.arreter();
  });

  it('LANGUE=en change toutes les réponses', async () => {
    const { socle, transport, envoyes } = await monter({ env: { LANGUE: 'en' } });
    transport.injecter('alice', '!points');
    transport.injecter('bob', '!privacy');
    transport.injecter('streamer', '!game start', { diffuseur: true });
    const lignes = await envoyes();
    expect(lignes[0]).toBe('@alice 0 points, 0 wins.');
    expect(lignes[1]).toMatch(/months without playing/);
    expect(lignes[2]).toMatch(/^🔢 New round/);
    await socle.arreter();
  });
});

describe('modération depuis le chat', () => {
  it('!jeu stop d’un spectateur sans badge : ignoré, aucune réponse', async () => {
    const { socle, transport, clock, envoyes } = await monter();
    transport.injecter('streamer', '!jeu start', { diffuseur: true });
    await envoyes();
    const avant = transport.envoyes.length;
    transport.injecter('moderator', '!jeu stop');
    expect(socle.jeu.vue(clock.now()).phase).toBe('manche');
    expect(await envoyes()).toHaveLength(avant);
    await socle.arreter();
  });

  it('!jeu stop d’un modérateur ou du streamer : exécuté', async () => {
    const { socle, transport, clock } = await monter();
    transport.injecter('streamer', '!jeu start', { diffuseur: true });
    transport.injecter('mod', '!jeu stop', { modo: true });
    expect(socle.jeu.vue(clock.now()).phase).toBe('attente');
    transport.injecter('streamer', '!jeu start', { diffuseur: true });
    transport.injecter('streamer', '!jeu skip', { diffuseur: true });
    expect(socle.jeu.vue(clock.now()).phase).toBe('manche');
    await socle.arreter();
  });
});

describe('retraits', () => {
  it('CLEARMSG retire la réponse, CLEARCHAT ciblé retire celles du joueur, !oubliemoi aussi', async () => {
    const { socle, transport, clock, envoyes } = await monter();
    transport.injecter('streamer', '!jeu start', { diffuseur: true });
    const id = transport.injecter('alice', '50');
    transport.injecter('bob', '60');
    transport.injecter('carl', '70');
    const reponses = () => socle.jeu.vue(clock.now()).reponses;
    expect(reponses()).toBe(3);

    transport.retirer({ type: 'message', messageId: id });
    expect(reponses()).toBe(2);

    transport.retirer({ type: 'utilisateur', userId: userIdDe('bob'), login: 'bob', dureeSecondes: 600 });
    expect(reponses()).toBe(1);

    transport.injecter('carl', '!oubliemoi');
    expect(reponses()).toBe(0);
    expect((await envoyes()).at(-1)).toMatch(/^@carl c’est fait/);
    await socle.arreter();
  });
});

describe('redémarrage en pleine manche', () => {
  it('aucun point compté, et le chat est prévenu', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'socle-'));
    dossiers.push(d);
    const env = { DB_PATH: path.join(d, 'jeu.db') };

    const premier = await monter({ env });
    premier.transport.injecter('streamer', '!jeu start', { diffuseur: true });
    premier.transport.injecter('alice', '42');
    // Arrêt brutal : ni fin de manche, ni arrêt propre. La base reste telle quelle.
    premier.socle.outils.store.close();
    await premier.socle.app.close();

    const second = await monter({ env });
    await vi.waitFor(() =>
      expect(second.transport.envoyes).toContain('La manche en cours a été interrompue, aucun point n’a été compté.'),
    );
    expect(second.socle.outils.scores.classement()).toEqual([]);
    await second.socle.arreter();
  });
});
