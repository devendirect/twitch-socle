import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AcceleratedClock, systemClock } from './clock.js';
import { lancer, type Socle } from './demarrer.js';
import type { ChatLine, ChatTransport, EtatAuth, FabriqueJeu, ProfilSimu, Retrait } from './types.js';

/**
 * Simulateur de chat (section 10 du brief) : développer sans stream, et
 * filmer les shorts du jeudi avec une partie animée.
 *
 * Aucune connexion à Twitch : le transport est remplacé par un faux, et les
 * messages des faux spectateurs passent par **le même chemin** que les vrais
 * (entrée, commandes, jeu, sortie).
 */

/** Tirage reproductible : même graine, même suite. */
export function mulberry32(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pseudos inventés, liste fixe : jamais de vrais pseudos à l'image. */
export const PSEUDOS_FICTIFS: readonly string[] = [
  'Pixel_Lapin', 'TartineDuMatin', 'CapitaineMoustache', 'LoutreCosmique', 'Brioche42',
  'NuageRapide', 'Ziggy_Croquette', 'MadameRadis', 'Le_Hibou_Bleu', 'PatateCurieuse',
  'Biscotte_Royale', 'Renard_Pressé', 'GlaçonTiède', 'Mistral_Doux', 'PoireDeTerre',
  'CafeCroissant', 'TortueTurbo', 'Kiwi_Solaire', 'Plume_Grise', 'ChaussetteLibre',
  'Gaufre_Express', 'MarmotteZen', 'Cactus_Câlin', 'PingouinPressé', 'Radis_Noir',
  'LuneDeMiel', 'Tonnerre_Mou', 'Crumble_Vert', 'ÉcureuilAgile', 'Bulle_de_Savon',
  'Noisette_Folle', 'PhareDuNord', 'Grenouille_Zen', 'Mangue_Sauvage', 'ColibriLent',
  'Panda_Pensif', 'Céleri_Rave', 'Moustique_Poli', 'Abricot_Sec', 'Hérisson_Doux',
  'Caramel_Salé', 'Yeti_Timide', 'Tempête_Calme', 'Cerise_Noire', 'Bison_Futé',
  'Pistache_Bleue', 'Lama_Pressé', 'Chamallow_Fou', 'Corbeau_Gentil', 'Mirabelle_99',
];

const BAVARDAGES: readonly string[] = [
  'salut tout le monde', 'trop bien ce jeu', 'je suis nul à ça mdr', 'gg', 'allez allez',
  'on est combien ce soir ?', 'hello', 'c’était serré', 'je l’avais dit !', 'lol',
];

/** Identifiant Twitch stable dérivé du pseudo : deux sessions, même joueur. */
export function userIdDe(nom: string): string {
  return String(parseInt(createHash('sha256').update(nom.toLowerCase()).digest('hex').slice(0, 8), 16));
}

/**
 * Faux transport : même interface que Twitch. Le bot est réputé modérateur
 * (100 messages / 30 s) pour que les prises de vue ne traînent pas.
 */
export class TransportSimule implements ChatTransport {
  readonly loginBot = 'bot_simu';
  readonly etat: EtatAuth = 'authenticated';
  readonly eleve = true;
  readonly envoyes: string[] = [];
  /** Appelé à chaque message du bot (le terminal l'affiche). */
  surEnvoi: ((texte: string) => void) | null = null;
  #connecte = false;
  #compteur = 0;
  readonly #handlers: Array<(line: ChatLine) => void> = [];
  readonly #retraitHandlers: Array<(retrait: Retrait) => void> = [];

  get connecte(): boolean {
    return this.#connecte;
  }

  async connecter(): Promise<void> {
    this.#connecte = true;
  }

  async fermer(): Promise<void> {
    this.#connecte = false;
  }

  envoyer(texte: string): void {
    this.envoyes.push(texte);
    this.surEnvoi?.(texte);
  }

  surMessage(handler: (line: ChatLine) => void): void {
    this.#handlers.push(handler);
  }

  surRetrait(handler: (retrait: Retrait) => void): void {
    this.#retraitHandlers.push(handler);
  }

  /** Un spectateur écrit. Renvoie l'identifiant du message. */
  injecter(nom: string, texte: string, options: { modo?: boolean; diffuseur?: boolean } = {}): string {
    const id = `simu-${++this.#compteur}`;
    const line: ChatLine = {
      id,
      userId: userIdDe(nom),
      login: nom.toLowerCase(),
      displayName: nom,
      channel: 'simulation',
      text: texte,
      isModerator: options.modo ?? false,
      isBroadcaster: options.diffuseur ?? false,
    };
    for (const handler of this.#handlers) handler(line);
    return id;
  }

  retirer(retrait: Retrait): void {
    for (const handler of this.#retraitHandlers) handler(retrait);
  }
}

export interface SimulateurOptions<V> {
  transport: TransportSimule;
  joueurs: number;
  graine: number;
  profil?: ProfilSimu<V> | undefined;
  vue: () => V;
}

/**
 * Le rythme d'un chat : à chaque pas (une seconde de jeu), chaque faux
 * spectateur a une petite chance de répondre — d'où des réponses étalées, des
 * retardataires, et des réponses changées. Un peu de bavardage, un `!points`
 * de temps en temps, un `!oubliemoi` rare.
 */
export class Simulateur<V> {
  readonly #options: SimulateurOptions<V>;
  readonly #aleatoire: () => number;
  readonly pseudos: readonly string[];

  constructor(options: SimulateurOptions<V>) {
    this.#options = options;
    this.#aleatoire = mulberry32(options.graine);
    const n = Math.max(1, Math.min(options.joueurs, PSEUDOS_FICTIFS.length));
    this.pseudos = PSEUDOS_FICTIFS.slice(0, n);
  }

  pas(): void {
    const { transport, profil, vue } = this.#options;
    const r = this.#aleatoire;
    for (const nom of this.pseudos) {
      const tirage = r();
      if (tirage < 0.08 && profil) {
        const reponse = profil.reponse(vue(), r, nom);
        if (reponse) transport.injecter(nom, reponse);
      } else if (tirage < 0.09) {
        transport.injecter(nom, BAVARDAGES[Math.floor(r() * BAVARDAGES.length)]!);
      } else if (tirage < 0.0915) {
        transport.injecter(nom, '!points');
      } else if (tirage < 0.0917) {
        transport.injecter(nom, '!oubliemoi');
      }
    }
  }
}

/** `--joueurs 25 --graine 42 --vitesse 2` */
export function lireArguments(argv: readonly string[]): { joueurs: number; graine: number; vitesse: number } {
  const valeur = (nom: string, defaut: number) => {
    const i = argv.indexOf(`--${nom}`);
    const n = i === -1 ? NaN : Number(argv[i + 1]);
    return Number.isFinite(n) && n > 0 ? n : defaut;
  };
  return { joueurs: Math.floor(valeur('joueurs', 25)), graine: Math.floor(valeur('graine', 42)), vitesse: valeur('vitesse', 1) };
}

/**
 * `npm run simu` d'un jeu : démarre le jeu sur le faux transport, lance les
 * faux spectateurs, et ouvre une invite dans le terminal :
 *
 *   alice> 1987          alice écrit « 1987 »
 *   @mod> !jeu skip      un modérateur écrit « !jeu skip »
 *   !jeu start           le streamer écrit
 */
export async function lancerSimu<V>(
  fabrique: FabriqueJeu<V>,
  options: { argv?: readonly string[]; dossierPublic?: string } = {},
): Promise<Socle<V>> {
  const { joueurs, graine, vitesse } = lireArguments(options.argv ?? process.argv.slice(2));
  const transport = new TransportSimule();
  transport.surEnvoi = (texte) => console.log(`  bot> ${texte}`);

  const clock = vitesse === 1 ? systemClock : new AcceleratedClock(new Date().toISOString(), vitesse);
  const socle = await lancer(fabrique, {
    // Une simulation ne touche ni la vraie chaîne, ni les vrais scores.
    env: { ...process.env, TWITCH_CHANNEL: '', TWITCH_BOT_TOKEN: '', TWITCH_BOT_USERNAME: '', DB_PATH: ':memory:' },
    transport,
    clock,
    aleatoire: mulberry32(graine + 1),
    simulation: true,
    ticMs: Math.max(50, 1000 / vitesse),
    ...(options.dossierPublic ? { dossierPublic: options.dossierPublic } : {}),
  });

  const simulateur = new Simulateur({ transport, joueurs, graine, profil: socle.jeu.profilSimu, vue: () => socle.jeu.vue(clock.now()) });
  setInterval(() => simulateur.pas(), Math.max(50, 1000 / vitesse));
  console.log(`  SIMULATION — ${simulateur.pseudos.length} spectateurs, graine ${graine}, vitesse ×${vitesse}.`);
  console.log('  Écris « pseudo> message », « @pseudo> message » (modérateur), ou un message du streamer.\n');

  const invite = createInterface({ input: process.stdin });
  invite.on('line', (ligne) => {
    const match = /^(@?)([^>\s]+)>\s?(.*)$/.exec(ligne.trim());
    if (match) transport.injecter(match[2]!, match[3]!, { modo: match[1] === '@' });
    else if (ligne.trim()) transport.injecter('streamer', ligne.trim(), { diffuseur: true });
  });
  return socle;
}
