/** Variables d'environnement validées au démarrage (section 11 du brief). */

import { describe, expect, it } from 'vitest';
import { ConfigError, champs, lireConfig } from '../src/config.js';
import { DEFAULT_IGNORED_BOTS } from '../src/chat/irc.js';

const JETON = 'x'.repeat(32);

describe('configuration', () => {
  it('applique les valeurs par défaut', () => {
    const config = lireConfig({});
    expect(config.PORT).toBe(3001);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.LANGUE).toBe('fr');
    expect(config.PURGE_MOIS).toBe(12);
    expect(config.BOTS_IGNORES).toEqual([...DEFAULT_IGNORED_BOTS]);
    expect(config.TWITCH_CHANNEL).toBeUndefined();
  });

  it('traite une variable vide comme absente', () => {
    const config = lireConfig({ TWITCH_CHANNEL: '', PORT: '', LANGUE: ' ' });
    expect(config.TWITCH_CHANNEL).toBeUndefined();
    expect(config.PORT).toBe(3001);
    expect(config.LANGUE).toBe('fr');
  });

  it('lit les valeurs fournies', () => {
    const config = lireConfig({ TWITCH_CHANNEL: '#DevEnDirect', LANGUE: 'en', BOTS_IGNORES: '@MonBot, nightbot' });
    expect(config.TWITCH_CHANNEL).toBe('devendirect');
    expect(config.LANGUE).toBe('en');
    expect(config.BOTS_IGNORES).toContain('monbot');
    expect(config.BOTS_IGNORES.filter((b) => b === 'nightbot')).toHaveLength(1);
  });

  it('refuse une langue inconnue, un port faux, une chaîne invalide', () => {
    expect(() => lireConfig({ LANGUE: 'de' })).toThrow(/LANGUE/);
    expect(() => lireConfig({ PORT: '30OO' })).toThrow(/PORT="30OO"/);
    expect(() => lireConfig({ TWITCH_CHANNEL: 'ma chaîne' })).toThrow(/TWITCH_CHANNEL/);
  });

  it('écoute ouverte au réseau sans PANEL_TOKEN : refus de démarrer', () => {
    expect(() => lireConfig({ HOST: '0.0.0.0' })).toThrow(/PANEL_TOKEN/);
    expect(lireConfig({ HOST: '0.0.0.0', PANEL_TOKEN: JETON }).PANEL_TOKEN).toBe(JETON);
    expect(lireConfig({ HOST: 'localhost' }).HOST).toBe('localhost');
  });

  it('refuse un PANEL_TOKEN trop court, sans le recopier', () => {
    try {
      lireConfig({ PANEL_TOKEN: 'court-mais-secret' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('PANEL_TOKEN');
      expect((error as Error).message).not.toContain('court-mais-secret');
    }
  });

  it('exige le login du bot avec son jeton', () => {
    expect(() => lireConfig({ TWITCH_BOT_TOKEN: 'oauth:abc' })).toThrow(/TWITCH_BOT_USERNAME/);
  });

  it('variables propres au jeu : validées avec les autres, secrets masqués', () => {
    const extra = { CLE_API: champs.texte, LIMITE: champs.entier(1, 10, 5) };
    const config = lireConfig({ CLE_API: 'abc' }, { extra, portParDefaut: 3000 });
    expect(config.CLE_API).toBe('abc');
    expect(config.LIMITE).toBe(5);
    expect(config.PORT).toBe(3000);
    expect(lireConfig({}).PORT).toBe(3001);
    try {
      lireConfig(
        { LIMITE: '99', PURGE_MOIS: 'y', CLE_API: 'secrète' },
        { extra: { ...extra, CLE_API: champs.entier(1, 2, 1) }, secrets: ['CLE_API'] },
      );
      expect.unreachable();
    } catch (error) {
      const problems = (error as ConfigError).problems.join('\n');
      expect((error as ConfigError).problems).toHaveLength(3);
      expect(problems).toContain('LIMITE="99"');
      expect(problems).toContain('CLE_API=***');
      expect(problems).not.toContain('secrète');
    }
  });

  it('liste tous les problèmes d’un coup', () => {
    try {
      lireConfig({ PORT: 'x', PURGE_MOIS: 'y', LANGUE: 'de' });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).problems).toHaveLength(3);
    }
  });
});
