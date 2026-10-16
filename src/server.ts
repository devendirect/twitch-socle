import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { z } from 'zod';

/**
 * Serveur HTTP commun : Fastify, fichiers statiques, `/events`, et **toute la
 * sécurité HTTP** (section 7 du brief, reprise du SNCF et complétée).
 *
 *   1. écoute sur `127.0.0.1` par défaut (`config.ts`) ;
 *   2. en-tête `Host` en liste blanche sur toutes les requêtes : contre le
 *      DNS rebinding, qui se présente comme « même origine » ;
 *   3. contrôle d'origine sur tout ce qui modifie : `Sec-Fetch-Site` et `Origin` ;
 *   4. pas d'analyseur `text/plain` : un formulaire forgé est rejeté en 415 ;
 *   5. `PANEL_TOKEN` en `Authorization: Bearer …` sur `/api/*` s'il est défini
 *      (obligatoire dès que l'écoute sort de la machine) ;
 *   6. corps validés par Zod, champ inconnu refusé (`valider`) ;
 *   7. CSP, `nosniff`, `no-referrer` sur toutes les réponses.
 */

/** Noms sous lesquels la machine locale est jointe, quel que soit le port. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * L'en-tête `Host` désigne-t-il ce serveur ?
 *
 * Contre le DNS rebinding : une page dont le domaine pointe vers 127.0.0.1
 * envoie un `Origin` égal à son `Host`, et `Sec-Fetch-Site: same-origin`. Les
 * verrous d'origine la laissent passer ; son `Host`, lui, reste son domaine.
 *
 * Un hôte ajouté écrit seul (`mon-pc.local`) vaut pour tous les ports ;
 * `nom:port`, pour ce port-là.
 */
export function isAllowedHost(host: string | undefined, extra: readonly string[] = []): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  const hostname = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : (value.split(':')[0] ?? '');
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  return extra.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    return allowed !== '' && (allowed === value || allowed === hostname);
  });
}

/**
 * Empreintes des scripts écrits dans les pages (`<script>` sans `src`).
 *
 * La politique de sécurité n'autorise que les scripts servis par l'application
 * et ceux-là, nommément : `'unsafe-inline'` aurait laissé passer n'importe quel
 * script injecté, ce qui retire l'essentiel de la protection. Calculées au
 * démarrage : une page modifiée pendant que le serveur tourne demande un
 * redémarrage.
 *
 * Le navigateur hache le texte APRÈS avoir ramené les fins de ligne à `\n` —
 * les pages du SNCF sont en CRLF, il faut faire de même.
 *
 * Copié de `sncf/src/server/security.ts`.
 */
export function inlineScriptHashes(dir: string): string[] {
  const hashes = new Set<string>();
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') visit(full);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = readFileSync(full, 'utf8');
      for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        const body = (match[1] ?? '').replace(/\r\n?/g, '\n');
        hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
      }
    }
  };
  visit(dir);
  return [...hashes];
}

/**
 * Sources ajoutées par un jeu à la politique de sécurité, directive par
 * directive. Le SNCF en a besoin : tuiles IGN (`connect-src`), photos
 * Wikimedia (`img-src`), worker de MapLibre (`worker-src blob:`), styles en
 * ligne de son studio. Jamais `script-src` : un script externe ou
 * `'unsafe-inline'` retirerait l'essentiel de la protection.
 */
export type CspSupplement = Partial<
  Record<'style-src' | 'img-src' | 'connect-src' | 'worker-src' | 'child-src' | 'font-src', readonly string[]>
>;

/**
 * En-têtes de sécurité, sur toutes les réponses. Par défaut, aucun script
 * externe, aucune connexion sortante depuis les pages : tout est servi par le
 * jeu. Un jeu élargit une directive par `supplement`, nommément.
 */
export function securityHeaders(publicDirs: readonly string[], supplement: CspSupplement = {}): Record<string, string> {
  const hashes = publicDirs.flatMap((dir) => inlineScriptHashes(dir));
  const directive = (nom: keyof CspSupplement, base: readonly string[]) =>
    `${nom} ${[...new Set([...base, ...(supplement[nom] ?? [])])].join(' ')}`;
  const csp = [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ` ${[...new Set(hashes)].join(' ')}` : ''}`,
    directive('style-src', ["'self'"]),
    directive('img-src', ["'self'", 'data:']),
    directive('connect-src', ["'self'"]),
    ...(supplement['worker-src'] ? [directive('worker-src', ["'self'"])] : []),
    ...(supplement['child-src'] ? [directive('child-src', ["'self'"])] : []),
    directive('font-src', ["'self'"]),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

/** Comparaison en temps constant : la durée ne trahit pas le préfixe juste. */
function memeJeton(recu: string, attendu: string): boolean {
  const a = createHash('sha256').update(recu).digest();
  const b = createHash('sha256').update(attendu).digest();
  return timingSafeEqual(a, b);
}

/**
 * Valide un corps de requête. Le schéma doit être `.strict()` : un champ
 * inconnu est refusé (400), pas ignoré en silence.
 */
export function valider<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  void reply.code(400).send({
    error: 'Requête invalide.',
    details: result.error.issues.map((issue) => `${issue.path.join('.') || '(corps)'} : ${issue.message}`),
  });
  return undefined;
}

export interface DossierPublic {
  racine: string;
  /** Préfixe d'URL : `/` pour le jeu, `/socle/` et `/vendor/` pour le socle. */
  prefixe: string;
}

export interface ServeurOptions {
  dossiers: DossierPublic[];
  hotesAutorises?: readonly string[];
  /** Si défini, exigé en `Authorization: Bearer …` sur `/api/*`. */
  panelToken?: string | undefined;
  /** Sources ajoutées à la politique de sécurité (`CspSupplement`). */
  csp?: CspSupplement;
  /**
   * Routes `/api/*` lues par l'overlay, donc sans `PANEL_TOKEN` : en GET et
   * HEAD seulement, et comparées à la route déclarée, pas à l'URL tapée. Le
   * SNCF : `/api/overlay-config`, l'apparence que la source OBS doit lire.
   * Rien de secret ne doit y passer.
   */
  lecturesPubliques?: readonly string[];
}

export function creerServeur(options: ServeurOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const hotes = options.hotesAutorises ?? [];

  /**
   * Avant tout le reste, lectures comprises : une page en DNS rebinding lirait
   * `/api/*` et `/events` aussi bien qu'elle piloterait le jeu.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host, hotes)) {
      return reply.code(403).send({ error: 'Requête refusée : hôte inconnu.' });
    }
  });

  /**
   * Aucune page extérieure ne pilote le jeu. Deux verrous (repris du SNCF,
   * où un lien posté dans le chat suffisait à annuler la partie) :
   *
   *   1. `Sec-Fetch-Site` refusé dès qu'il vaut autre chose que `same-origin`
   *      ou `none` : les navigateurs le posent, une page ne le falsifie pas ;
   *   2. `Origin`, s'il est présent, doit désigner l'hôte appelé. Il est
   *      absent pour `curl` et les scripts locaux, qui restent utilisables.
   */
  app.addHook('onRequest', async (request, reply) => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return reply.code(403).send({ error: 'Requête refusée : origine externe.' });
    }

    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        return reply.code(403).send({ error: 'Requête refusée : origine illisible.' });
      }
      if (host !== request.headers.host || !isAllowedHost(host, hotes)) {
        return reply.code(403).send({ error: 'Requête refusée : origine externe.' });
      }
    }
  });

  /**
   * Le panneau, et lui seul, s'authentifie. L'overlay ne lit que `/events`,
   * et les `lecturesPubliques` déclarées par le jeu.
   */
  const token = options.panelToken;
  const publiques = new Set(options.lecturesPubliques ?? []);
  if (token) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      const lecture = request.method === 'GET' || request.method === 'HEAD';
      if (lecture && publiques.has(request.routeOptions.url ?? '')) return;
      const header = request.headers.authorization ?? '';
      const recu = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (!recu || !memeJeton(recu, token)) {
        return reply.code(401).send({ error: 'Mot de passe du panneau manquant ou faux.' });
      }
    });
  }

  /**
   * Un formulaire HTML ne parle pas JSON, mais il peut poster du `text/plain`,
   * qu'aucune route n'utilise : sans analyseur, la requête est rejetée en 415.
   */
  app.removeContentTypeParser('text/plain');

  const headers = securityHeaders(
    options.dossiers.map((d) => d.racine),
    options.csp,
  );
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers(headers);
    return payload;
  });

  options.dossiers.forEach((dossier, index) => {
    void app.register(fastifyStatic, {
      root: path.resolve(dossier.racine),
      prefix: dossier.prefixe,
      // Fastify n'accepte qu'une décoration `sendFile` : la première.
      decorateReply: index === 0,
    });
  });

  return app;
}
