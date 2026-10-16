import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TwitchChatClient } from './chat/client.js';
import { Entree } from './chat/entree.js';
import { Sortie, type SortieOptions } from './chat/sortie.js';
import { systemClock, type Clock } from './clock.js';
import { COMMANDES_SOCLE, actionModeration, analyser, indexer } from './commandes.js';
import { ConfigError, ecouteLocale, lireConfig, type Config } from './config.js';
import { messagesEn } from './i18n/messages.en.js';
import { messagesFr } from './i18n/messages.fr.js';
import { LimiteFrequence } from './limites.js';
import { Scores } from './scores.js';
import { creerServeur, valider, type DossierPublic } from './server.js';
import { SseHub } from './sse.js';
import { Store } from './store.js';
import type {
  ChatTransport,
  Commande,
  FabriqueJeu,
  Logger,
  Messages,
  MiniJeu,
  OptionsDire,
  OutilsSocle,
  Texte,
} from './types.js';

/**
 * Branche un jeu sur le socle : configuration, chat, commandes communes,
 * points, base, overlay, serveur, arrêt propre.
 *
 * Un jeu n'écrit que sa règle (`FabriqueJeu`), ses textes et son écran.
 */

const SOCLE_PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

/** Délai maximal d'un arrêt propre. */
const ARRET_MAX_MS = 5000;

export interface DemarrageOptions {
  /** Variables d'environnement ; `process.env` par défaut. */
  env?: Record<string, string | undefined>;
  /** Transport de chat imposé : le simulateur, ou un faux dans les tests. */
  transport?: ChatTransport;
  /** Dossier `public/` du jeu, servi à la racine. */
  dossierPublic?: string;
  /** Base par défaut quand `DB_PATH` est vide. */
  dbParDefaut?: string;
  clock?: Clock;
  aleatoire?: () => number;
  logger?: Logger;
  /** Signalé au panneau (`/api/etat`), jamais à l'overlay. */
  simulation?: boolean;
  /** Faux dans les tests : pas de port ouvert, `app.inject` suffit. */
  ecouter?: boolean;
  /** Cadence de `tic` ; `null` : les tests appellent `tic()` eux-mêmes. */
  ticMs?: number | null;
  sortie?: Partial<Omit<SortieOptions, 'transport'>>;
}

/** Ce que l'overlay reçoit. */
export interface VueDiffusee<V> {
  jeu: V;
  attribution: string;
}

export interface Socle<V> {
  app: FastifyInstance;
  jeu: MiniJeu<V>;
  outils: OutilsSocle;
  config: Config;
  transport: ChatTransport;
  sortie: Sortie;
  entree: Entree;
  sse: SseHub<VueDiffusee<V>>;
  /** Un pas d'horloge : ce que le minuteur fait chaque seconde. */
  tic(): void;
  arreter(): Promise<void>;
}

export async function demarrerJeu<V>(fabrique: FabriqueJeu<V>, options: DemarrageOptions = {}): Promise<Socle<V>> {
  const config = lireConfig(options.env ?? process.env);
  const logger = options.logger ?? consoleLogger;
  const clock = options.clock ?? systemClock;
  const aleatoire = options.aleatoire ?? Math.random;

  // ─── Base et durée de conservation ─────────────────────────────────────────
  const dbPath = config.DB_PATH ?? options.dbParDefaut ?? 'data/jeu.db';
  const store = new Store(dbPath);
  const limite = new Date(clock.now());
  limite.setMonth(limite.getMonth() - config.PURGE_MOIS);
  const purges = store.purgeInactive(limite);
  if (purges > 0) logger.info(`${purges} joueur(s) inactif(s) depuis ${config.PURGE_MOIS} mois effacé(s).`);
  const scores = new Scores({ store, now: () => clock.now() });

  // ─── Chat ──────────────────────────────────────────────────────────────────
  const transport =
    options.transport ??
    (config.TWITCH_CHANNEL
      ? new TwitchChatClient({
          channel: config.TWITCH_CHANNEL,
          token: config.TWITCH_BOT_TOKEN,
          username: config.TWITCH_BOT_USERNAME,
          logger,
        })
      : null);
  if (!transport) {
    store.close();
    throw new ConfigError(['TWITCH_CHANNEL="" : chaîne absente — renseigne-la, ou lance le simulateur (npm run simu)']);
  }
  const sortie = new Sortie({ transport, logger, ...options.sortie });
  const entree = new Entree({ transport, botsIgnores: config.BOTS_IGNORES, logger });

  // ─── Outils du jeu ─────────────────────────────────────────────────────────
  const socle: Messages = config.LANGUE === 'en' ? messagesEn : messagesFr;
  let messagesJeu: Messages = {};
  let sse: SseHub<VueDiffusee<V>> | null = null;

  const texte = (cle: string, parametres: Record<string, unknown>, depuis: Messages[]): Texte | null => {
    for (const messages of depuis) {
      const message = messages[cle];
      if (message) return message(parametres);
    }
    logger.warn(`Message « ${cle} » absent des textes (${config.LANGUE}).`);
    return null;
  };
  const dire = (cle: string, parametres: Record<string, unknown> = {}, opts: OptionsDire = {}, depuis = [messagesJeu, socle]) => {
    const t = texte(cle, parametres, depuis);
    if (t !== null) void sortie.dire(t, opts);
  };

  const outils: OutilsSocle = {
    chat: { dire: (cle, parametres, opts) => dire(cle, parametres, opts) },
    scores,
    store,
    clock,
    logger,
    limites: { creer: (o) => new LimiteFrequence({ ...o, maintenant: () => clock.now().getTime() }) },
    aleatoire,
    diffuser: () => sse?.publish(),
    manches: {
      ouvrir: (id) => store.openRound(id, jeu.id, clock.now()),
      fermer: (id, statut = 'terminee') => store.closeRound(id, statut, clock.now()),
    },
  };

  const jeu = fabrique(outils);
  messagesJeu = config.LANGUE === 'en' ? jeu.messages.en : jeu.messages.fr;
  const index = indexer(COMMANDES_SOCLE, jeu.commandes);
  const vue = (): VueDiffusee<V> => ({ jeu: jeu.vue(clock.now()), attribution: jeu.attribution });
  sse = new SseHub(vue);
  const hub = sse;

  // ─── Commandes communes ────────────────────────────────────────────────────
  // Une réponse par personne et par commande toutes les 10 s ; le classement,
  // une fois toutes les 10 s pour tout le monde (un raid le demande en chœur).
  const parPersonne = new LimiteFrequence({ max: 1, fenetreMs: 10_000, maintenant: () => clock.now().getTime() });
  const classementGlobal = new LimiteFrequence({ max: 1, fenetreMs: 10_000, maintenant: () => clock.now().getTime() });
  const reponse: OptionsDire = { essentiel: false };

  const commandeSocle = (commande: Commande, now: Date): boolean => {
    const { joueur } = commande;
    const cle = `${joueur.userId}:${commande.nom}`;
    switch (commande.nom) {
      case 'points': {
        if (!parPersonne.autoriser(cle)) return true;
        const p = scores.get(joueur.userId);
        dire('points', { nom: joueur.displayName, points: p?.points ?? 0, victoires: p?.wins ?? 0 }, reponse, [socle]);
        return true;
      }
      case 'classement': {
        if (!classementGlobal.autoriser()) return true;
        const lignes = scores.classement(5).map((p) => ({ nom: p.displayName, victoires: p.wins, points: p.points }));
        dire(lignes.length ? 'classement' : 'classementVide', { lignes }, reponse, [socle]);
        return true;
      }
      case 'oubli':
        // Toujours confirmé : c'est un droit, et la réponse est actionnable.
        scores.forget(joueur.userId);
        jeu.surRetrait([], joueur.userId);
        parPersonne.oublier(cle);
        dire('oubli', { nom: joueur.displayName }, reponse, [socle]);
        return true;
      case 'donnees':
        if (!parPersonne.autoriser(cle)) return true;
        dire('donnees', { nom: joueur.displayName, mois: config.PURGE_MOIS }, reponse, [socle]);
        return true;
      case 'aide': {
        if (!parPersonne.autoriser(cle)) return true;
        const aideJeu = messagesJeu['aide']?.({}) ?? '';
        dire('aide', { jeu: typeof aideJeu === 'string' ? aideJeu : (aideJeu[0] ?? '') }, reponse, [socle]);
        return true;
      }
      case 'moderation': {
        // Un spectateur sans badge : ignoré en silence. Les badges sont lus
        // dans le message, jamais déduits du pseudo.
        if (!joueur.estModo) return true;
        const action = actionModeration(commande.args);
        if (action) jeu.surModeration(action, now);
        return true;
      }
      default:
        return false;
    }
  };

  entree.surMessage((message) => {
    const now = clock.now();
    const lue = analyser(message.texte, index);
    if (!lue) {
      jeu.surMessage?.(message, now);
    } else {
      const commande: Commande = { ...lue, joueur: message.joueur, messageId: message.id };
      if (!commandeSocle(commande, now)) jeu.surCommande(commande, now);
    }
    hub.publish();
  });

  entree.surRetrait((retrait) => {
    if (retrait.type === 'message') jeu.surRetrait([retrait.messageId]);
    else jeu.surRetrait([], retrait.userId);
    hub.publish();
  });

  // ─── Serveur ───────────────────────────────────────────────────────────────
  const dossiers: DossierPublic[] = [
    ...(options.dossierPublic ? [{ racine: options.dossierPublic, prefixe: '/' }] : []),
    { racine: `${SOCLE_PUBLIC}socle`, prefixe: '/socle/' },
    { racine: `${SOCLE_PUBLIC}vendor`, prefixe: '/vendor/' },
  ];
  const app = creerServeur({ dossiers, hotesAutorises: config.HOTES_AUTORISES, panelToken: config.PANEL_TOKEN });

  app.get('/events', (_request, reply) => {
    // Fastify ne doit pas toucher à la réponse : le flux SSE reste ouvert.
    reply.hijack();
    hub.subscribe(reply.raw);
  });

  // Jamais de secret ici : ni jeton, ni identifiant client.
  app.get('/api/etat', async () => ({
    jeu: jeu.id,
    simulation: options.simulation ?? false,
    langue: config.LANGUE,
    chat: { etat: transport.etat, connecte: transport.connecte },
  }));

  const Moderation = z.object({ action: z.enum(['start', 'stop', 'skip']) }).strict();
  app.post('/api/moderation', async (request, reply) => {
    const body = valider(Moderation, request.body, reply);
    if (!body) return reply;
    jeu.surModeration(body.action, clock.now());
    hub.publishNow();
    return { ok: true };
  });

  const panneau = jeu.panneau;
  if (panneau) {
    app.get('/api/jeu', async () => panneau.etat(clock.now()));
    app.post('/api/jeu', async (request, reply) => {
      const body: unknown = valider(panneau.schema, request.body, reply);
      if (body === undefined) return reply;
      const resultat = panneau.executer(body, clock.now());
      hub.publishNow();
      if (resultat?.erreur) return reply.code(409).send({ error: resultat.erreur });
      return { ok: true };
    });
  }

  // ─── Démarrage ─────────────────────────────────────────────────────────────
  const tic = () => {
    jeu.tic?.(clock.now());
    hub.publish();
  };
  const ticMs = options.ticMs === undefined ? 1000 : options.ticMs;
  const minuteur = ticMs === null ? null : setInterval(tic, ticMs);
  const battement = setInterval(() => hub.heartbeat(), 15_000);
  battement.unref?.();

  await transport.connecter();

  // Redémarrage en pleine manche : annulée sans points, et le chat le sait.
  if (store.interruptOpenRounds(jeu.id, clock.now()) > 0) dire('mancheInterrompue', {}, {}, [socle]);

  if (options.ecouter ?? true) {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info(banniere(config, jeu, transport, dbPath, options.simulation ?? false));
  } else {
    await app.ready();
  }

  let arret: Promise<void> | null = null;
  const arreter = () =>
    (arret ??= (async () => {
      if (minuteur) clearInterval(minuteur);
      clearInterval(battement);
      // La manche en cours est annulée sans points.
      jeu.surModeration('stop', clock.now());
      if (transport.etat === 'authenticated') dire('arret', {}, {}, [socle]);
      await sortie.attendreVide(ARRET_MAX_MS - 1000);
      sortie.fermer();
      hub.publishNow();
      hub.closeAll();
      await transport.fermer();
      await app.close();
      store.close();
    })());

  return { app, jeu, outils, config, transport, sortie, entree, sse: hub, tic, arreter };
}

function banniere<V>(config: Config, jeu: MiniJeu<V>, transport: ChatTransport, dbPath: string, simulation: boolean): string {
  const adresse = `http://${config.HOST.includes(':') ? `[${config.HOST}]` : config.HOST}:${config.PORT}`;
  const chat = simulation
    ? 'SIMULATION (aucune connexion à Twitch)'
    : `#${config.TWITCH_CHANNEL}${transport.loginBot ? ` — bot ${transport.loginBot}` : ' — lecture seule (aucun jeton)'}`;
  return `
  Jeu                ${jeu.id} — ${adresse}
  Flux de l’overlay  ${adresse}/events
  Chat               ${chat}
  Langue du bot      ${config.LANGUE}
  Écoute             ${ecouteLocale(config.HOST) ? 'machine locale seulement' : `${config.HOST} — panneau protégé par PANEL_TOKEN`}
  Hôtes acceptés     localhost, 127.0.0.1, [::1]${config.HOTES_AUTORISES.length ? `, ${config.HOTES_AUTORISES.join(', ')}` : ''}
  Bots ignorés       ${config.BOTS_IGNORES.join(', ')}
  Persistance        ${dbPath} — joueurs inactifs effacés après ${config.PURGE_MOIS} mois
  Source             ${jeu.attribution}
`;
}

/**
 * Point d'entrée d'un jeu : démarre, et gère l'arrêt (Ctrl+C, SIGTERM) avec un
 * délai maximal de 5 s. Une configuration invalide arrête tout avec un
 * message clair.
 */
export async function lancer<V>(fabrique: FabriqueJeu<V>, options: DemarrageOptions = {}): Promise<Socle<V>> {
  let socle: Socle<V>;
  try {
    socle = await demarrerJeu(fabrique, options);
  } catch (error: unknown) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`\n  ${error.message.split('\n').join('\n  ')}\n\n  Corrige le fichier .env, puis relance.\n`);
    process.exit(1);
  }
  const quitter = () => {
    setTimeout(() => process.exit(1), ARRET_MAX_MS).unref();
    void socle.arreter().finally(() => process.exit(0));
  };
  process.once('SIGINT', quitter);
  process.once('SIGTERM', quitter);
  return socle;
}
