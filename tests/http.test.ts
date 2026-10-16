/**
 * Sécurité HTTP (section 7 du brief, tests « HTTP » de la section 14).
 * Le serveur est monté sans ouvrir de port : `app.inject` suffit.
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { demarrerJeu } from '../src/demarrer.js';
import { TransportSimule } from '../src/simu.js';
import { chercherHtmlBrut } from '../src/verif.js';
import { creerServeur, securityHeaders } from '../src/server.js';
import { jeuFactice } from './jeu-factice.js';

const JETON_PANNEAU = 'p'.repeat(40);
const JETON_BOT = 'oauth:jetonbotsecret123456';

async function serveur(env: Record<string, string> = {}) {
  const socle = await demarrerJeu(jeuFactice, {
    env: { DB_PATH: ':memory:', TWITCH_BOT_TOKEN: JETON_BOT, TWITCH_BOT_USERNAME: 'bot', ...env },
    transport: new TransportSimule(),
    logger: { info: () => {}, warn: () => {} },
    ecouter: false,
    ticMs: null,
  });
  return socle;
}

const LOCAL = { host: 'localhost:3001' };
const POST_LOCAL = { ...LOCAL, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3001' };

describe('liste blanche de Host', () => {
  it('Host: evil.example → 403, même sur GET /events', async () => {
    const socle = await serveur();
    for (const url of ['/events', '/api/etat', '/socle/dom.js']) {
      const res = await socle.app.inject({ method: 'GET', url, headers: { host: 'evil.example' } });
      expect(res.statusCode).toBe(403);
    }
    await socle.arreter();
  });

  it('accepte localhost, 127.0.0.1, [::1] et HOTES_AUTORISES', async () => {
    const socle = await serveur({ HOTES_AUTORISES: 'mon-pc.local' });
    for (const host of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001', 'mon-pc.local:3001']) {
      const res = await socle.app.inject({ method: 'GET', url: '/api/etat', headers: { host } });
      expect(res.statusCode).toBe(200);
    }
    await socle.arreter();
  });
});

describe('requêtes qui modifient', () => {
  it('Sec-Fetch-Site: cross-site → 403', async () => {
    const socle = await serveur();
    const res = await socle.app.inject({
      method: 'POST', url: '/api/moderation', headers: { ...POST_LOCAL, 'sec-fetch-site': 'cross-site' }, payload: { action: 'stop' },
    });
    expect(res.statusCode).toBe(403);
    await socle.arreter();
  });

  it('Origin étranger → 403', async () => {
    const socle = await serveur();
    const res = await socle.app.inject({
      method: 'POST', url: '/api/moderation', headers: { ...POST_LOCAL, origin: 'https://evil.example' }, payload: { action: 'stop' },
    });
    expect(res.statusCode).toBe(403);
    await socle.arreter();
  });

  it('text/plain → 415', async () => {
    const socle = await serveur();
    const res = await socle.app.inject({
      method: 'POST', url: '/api/moderation', headers: { ...POST_LOCAL, 'content-type': 'text/plain' }, payload: '{"action":"stop"}',
    });
    expect(res.statusCode).toBe(415);
    await socle.arreter();
  });

  it('champ inconnu → 400', async () => {
    const socle = await serveur();
    const res = await socle.app.inject({
      method: 'POST', url: '/api/moderation', headers: POST_LOCAL, payload: { action: 'stop', admin: true },
    });
    expect(res.statusCode).toBe(400);
    await socle.arreter();
  });

  it('une requête correcte passe', async () => {
    const socle = await serveur();
    const res = await socle.app.inject({ method: 'POST', url: '/api/moderation', headers: POST_LOCAL, payload: { action: 'start' } });
    expect(res.statusCode).toBe(200);
    await socle.arreter();
  });
});

describe('mot de passe du panneau', () => {
  const env = { HOST: '0.0.0.0', PANEL_TOKEN: JETON_PANNEAU };

  it('sans le bon jeton → 401', async () => {
    const socle = await serveur(env);
    for (const authorization of [undefined, 'Bearer faux', `Bearer ${JETON_PANNEAU}x`, JETON_PANNEAU]) {
      const res = await socle.app.inject({
        method: 'GET', url: '/api/etat', headers: { ...LOCAL, ...(authorization ? { authorization } : {}) },
      });
      expect(res.statusCode).toBe(401);
    }
    await socle.arreter();
  });

  it('avec le bon jeton → 200 ; l’overlay n’en a pas besoin', async () => {
    const socle = await serveur(env);
    const api = await socle.app.inject({ method: 'GET', url: '/api/etat', headers: { ...LOCAL, authorization: `Bearer ${JETON_PANNEAU}` } });
    expect(api.statusCode).toBe(200);
    const page = await socle.app.inject({ method: 'GET', url: '/socle/live.js', headers: LOCAL });
    expect(page.statusCode).toBe(200);
    await socle.arreter();
  });

  it('lectures publiques : la route déclarée, en lecture seulement', async () => {
    const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
    const app = creerServeur({
      dossiers: [{ racine: publicDir, prefixe: '/' }],
      panelToken: JETON_PANNEAU,
      lecturesPubliques: ['/api/apparence'],
    });
    app.get('/api/apparence', async () => ({ couleur: 'bleu' }));
    app.put('/api/apparence', async () => ({ ok: true }));
    app.get('/api/apparence/:id', async () => ({ secret: true }));
    app.get('/api/prive', async () => ({ secret: true }));

    const get = (url: string) => app.inject({ method: 'GET', url, headers: LOCAL });
    expect((await get('/api/apparence')).statusCode).toBe(200);
    expect((await get('/api/apparence?x=1')).statusCode).toBe(200);
    expect((await get('/api/apparence/1')).statusCode).toBe(401);
    expect((await get('/api/prive')).statusCode).toBe(401);
    const put = await app.inject({ method: 'PUT', url: '/api/apparence', headers: { ...POST_LOCAL, host: 'localhost:3001' }, payload: {} });
    expect(put.statusCode).toBe(401);
    await app.close();
  });

  it('sans PANEL_TOKEN, une écoute ouverte au réseau refuse de démarrer', async () => {
    await expect(serveur({ HOST: '0.0.0.0' })).rejects.toThrow(/PANEL_TOKEN/);
  });
});

describe('réponses', () => {
  it('portent les en-têtes de sécurité', async () => {
    const socle = await serveur();
    for (const url of ['/api/etat', '/socle/dom.js', '/vendor/fonts.css']) {
      const res = await socle.app.inject({ method: 'GET', url, headers: LOCAL });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
    await socle.arreter();
  });

  it('un jeu élargit la politique nommément, sans toucher aux scripts', async () => {
    const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
    const defaut = securityHeaders([publicDir])['content-security-policy']!;
    expect(defaut).not.toContain('worker-src');
    const csp = securityHeaders([publicDir], {
      'img-src': ['https:'],
      'connect-src': ['https://data.geopf.fr'],
      'worker-src': ['blob:'],
    })['content-security-policy']!;
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("connect-src 'self' https://data.geopf.fr");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toContain('child-src');
    // Le reste ne bouge pas : script-src identique, aucune autre directive.
    const scripts = (p: string) => p.split('; ').find((d) => d.startsWith('script-src'));
    expect(scripts(csp)).toBe(scripts(defaut));

    const app = creerServeur({ dossiers: [{ racine: publicDir, prefixe: '/' }], csp: { 'img-src': ['https:'] } });
    const res = await app.inject({ method: 'GET', url: '/socle/dom.js', headers: LOCAL });
    expect(res.headers['content-security-policy']).toContain("img-src 'self' data: https:");
    await app.close();
  });

  it('un jeu lancé par `lancer` élargit aussi la politique (option csp)', async () => {
    const socle = await demarrerJeu(jeuFactice, {
      env: { DB_PATH: ':memory:' },
      transport: new TransportSimule(),
      logger: { info: () => {}, warn: () => {} },
      ecouter: false,
      ticMs: null,
      csp: { 'img-src': ['https://upload.wikimedia.org'] },
    });
    const res = await socle.app.inject({ method: 'GET', url: '/api/etat', headers: LOCAL });
    expect(res.headers['content-security-policy']).toContain("img-src 'self' data: https://upload.wikimedia.org");
    await socle.arreter();

    const sans = await serveur();
    const defaut = await sans.app.inject({ method: 'GET', url: '/api/etat', headers: LOCAL });
    expect(defaut.headers['content-security-policy']).toContain("img-src 'self' data:;");
    await sans.arreter();
  });

  it('ne contiennent jamais un jeton', async () => {
    const socle = await serveur({ HOST: '0.0.0.0', PANEL_TOKEN: JETON_PANNEAU });
    const headers = { ...LOCAL, authorization: `Bearer ${JETON_PANNEAU}` };
    for (const url of ['/api/etat', '/socle/dom.js', '/socle/live.js', '/socle/base.css', '/inconnue']) {
      const res = await socle.app.inject({ method: 'GET', url, headers });
      expect(res.body).not.toContain('jetonbotsecret123456');
      expect(res.body).not.toContain(JETON_PANNEAU);
    }
    await socle.arreter();
  });
});

describe('pages', () => {
  it('aucun innerHTML, outerHTML, insertAdjacentHTML ni document.write dans public/', () => {
    const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
    expect(chercherHtmlBrut(publicDir)).toEqual([]);
  });
});

describe('panneau du jeu (/api/jeu)', () => {
  const poster = (socle: Awaited<ReturnType<typeof serveur>>, payload: unknown, entetes: Record<string, string> = {}) =>
    socle.app.inject({ method: 'POST', url: '/api/jeu', headers: { ...POST_LOCAL, ...entetes }, payload: payload as object });

  it('GET : l’état privé du jeu ; il ne passe jamais par /events', async () => {
    const socle = await serveur();
    (socle.transport as TransportSimule).injecter('streamer', '!jeu start', { diffuseur: true });
    const res = await socle.app.inject({ method: 'GET', url: '/api/jeu', headers: LOCAL });
    expect(res.statusCode).toBe(200);
    const { secret } = res.json() as { secret: number };
    expect(secret).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(socle.jeu.vue(new Date()))).not.toContain('"secret":' + secret);
    await socle.arreter();
  });

  it('POST valide : exécuté ; refus du jeu : 409 avec son message', async () => {
    const socle = await serveur();
    const refus = await poster(socle, { action: 'secret', valeur: 42 });
    expect(refus.statusCode).toBe(409);
    expect(refus.json()).toEqual({ error: 'Aucune manche en cours.' });
    (socle.transport as TransportSimule).injecter('streamer', '!jeu start', { diffuseur: true });
    expect((await poster(socle, { action: 'secret', valeur: 42 })).statusCode).toBe(200);
    const etat = await socle.app.inject({ method: 'GET', url: '/api/jeu', headers: LOCAL });
    expect(etat.json()).toMatchObject({ secret: 42 });
    await socle.arreter();
  });

  it.each([
    ['champ inconnu', { action: 'secret', valeur: 42, en_plus: 1 }],
    ['valeur hors bornes', { action: 'secret', valeur: 500 }],
    ['action inconnue', { action: 'autre', valeur: 42 }],
    ['corps vide', {}],
  ])('%s → 400', async (_, payload) => {
    const socle = await serveur();
    expect((await poster(socle, payload)).statusCode).toBe(400);
    await socle.arreter();
  });

  it('mêmes verrous que le reste de /api : origine externe 403, jeton 401', async () => {
    const socle = await serveur();
    expect((await poster(socle, { action: 'secret', valeur: 42 }, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await poster(socle, { action: 'secret', valeur: 42 }, { origin: 'http://evil.example' })).statusCode).toBe(403);
    await socle.arreter();
    const protege = await serveur({ HOST: '0.0.0.0', PANEL_TOKEN: JETON_PANNEAU });
    expect((await protege.app.inject({ method: 'GET', url: '/api/jeu', headers: LOCAL })).statusCode).toBe(401);
    expect((await poster(protege, { action: 'secret', valeur: 42 })).statusCode).toBe(401);
    await protege.arreter();
  });
});
