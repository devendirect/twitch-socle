/**
 * Commandes, en français et en anglais (section 4 du brief), textes des deux
 * langues, et limite de fréquence.
 */

import { describe, expect, it } from 'vitest';
import { COMMANDES_SOCLE, actionModeration, analyser, indexer } from '../src/commandes.js';
import { LimiteFrequence } from '../src/limites.js';
import { messagesEn } from '../src/i18n/messages.en.js';
import { messagesFr } from '../src/i18n/messages.fr.js';

const INDEX = indexer(COMMANDES_SOCLE, { prenom: ['prenom', 'name'] });
const nom = (texte: string) => analyser(texte, INDEX)?.nom ?? null;

describe('alias', () => {
  const attendus: Record<string, string[]> = {
    points: ['!points', '!score', '!solde', '!balance'],
    classement: ['!classement', '!top', '!leaderboard'],
    oubli: ['!oubliemoi', '!oublie-moi', '!effacemoi', '!efface-moi', '!rgpd', '!forgetme', '!forget-me'],
    donnees: ['!donnees', '!données', '!data', '!privacy'],
    aide: ['!aide', '!help', '!commandes', '!commands'],
    moderation: ['!jeu start', '!game start'],
  };

  for (const [canonique, alias] of Object.entries(attendus)) {
    it(`${alias.join(', ')} → ${canonique}`, () => {
      for (const a of alias) expect(nom(a)).toBe(canonique);
    });
  }

  it('ignore la casse et les espaces en trop', () => {
    for (const texte of ['!CLASSEMENT', '!Classement', '  !classement  ']) expect(nom(texte)).toBe('classement');
    expect(analyser('!prenom    Kévin   Durand', INDEX)?.args).toEqual(['Kévin', 'Durand']);
  });

  it('ignore les accents sur le nom, jamais sur les arguments', () => {
    expect(nom('!DONNÉES')).toBe('donnees');
    expect(analyser('!prenom Kévin', INDEX)?.args).toEqual(['Kévin']);
    expect(analyser('!prenom Kevin', INDEX)?.args).toEqual(['Kevin']);
  });

  it('ajoute les commandes du jeu par la même table', () => {
    expect(nom('!name Léa')).toBe('prenom');
  });

  it('ignore ce qui n’est pas une commande connue', () => {
    expect(analyser('1987', INDEX)).toBeNull();
    expect(analyser('!inconnue', INDEX)).toBeNull();
    expect(analyser('salut !points', INDEX)).toBeNull();
  });

  it('refuse un alias déclaré deux fois', () => {
    expect(() => indexer(COMMANDES_SOCLE, { autre: ['top'] })).toThrow(/top/);
  });
});

describe('modération', () => {
  it('lit start, stop et skip en français et en anglais', () => {
    expect(actionModeration(['start'])).toBe('start');
    expect(actionModeration(['Démarrer'])).toBe('start');
    expect(actionModeration(['stop'])).toBe('stop');
    expect(actionModeration(['ARRÊTER'])).toBe('stop');
    expect(actionModeration(['skip'])).toBe('skip');
    expect(actionModeration(['passer'])).toBe('skip');
    expect(actionModeration(['danse'])).toBeNull();
    expect(actionModeration([])).toBeNull();
  });
});

describe('textes', () => {
  it('français et anglais ont exactement les mêmes clés', () => {
    expect(Object.keys(messagesEn).sort()).toEqual(Object.keys(messagesFr).sort());
  });

  it('aucun texte ne commence par une donnée du chat', () => {
    const piege = '/ban victime';
    const textes = [
      messagesFr.points({ nom: piege, points: 1, victoires: 0 }),
      messagesFr.oubli({ nom: piege }),
      messagesFr.donnees({ nom: piege, mois: 12 }),
      messagesFr.classement({ lignes: [{ nom: piege, victoires: 1, points: 1 }] }),
      messagesEn.points({ nom: piege, points: 1, victoires: 0 }),
    ];
    for (const t of textes) expect(String(t)).not.toMatch(/^[/.]/);
  });

  it('accorde le pluriel', () => {
    expect(messagesFr.points({ nom: 'a', points: 1, victoires: 0 })).toBe('@a 1 point, 0 victoire.');
    expect(messagesFr.points({ nom: 'a', points: 2, victoires: 3 })).toBe('@a 2 points, 3 victoires.');
    expect(messagesEn.points({ nom: 'a', points: 1, victoires: 2 })).toBe('@a 1 point, 2 wins.');
  });
});

describe('limite de fréquence', () => {
  it('autorise `max` actions par fenêtre et par clé', () => {
    let t = 0;
    const limite = new LimiteFrequence({ max: 2, fenetreMs: 10_000, maintenant: () => t });
    expect(limite.autoriser('a')).toBe(true);
    expect(limite.autoriser('a')).toBe(true);
    expect(limite.autoriser('a')).toBe(false);
    expect(limite.autoriser('b')).toBe(true);
    t = 10_000;
    expect(limite.autoriser('a')).toBe(true);
  });

  it('oublie une clé', () => {
    const limite = new LimiteFrequence({ max: 1, fenetreMs: 10_000, maintenant: () => 0 });
    limite.autoriser('a');
    limite.oublier('a');
    expect(limite.autoriser('a')).toBe(true);
  });
});
