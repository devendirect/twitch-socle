import { z } from 'zod';
import { DEFAULT_IGNORED_BOTS } from './chat/irc.js';

/**
 * Variables d'environnement, validées au démarrage (repris de `sncf/src/server/env.ts`).
 *
 * Une valeur invalide arrête le démarrage, avec la variable en cause et ce qui
 * est attendu : `PORT=30OO` donnait `NaN` dans le SNCF, et une faute dans le nom
 * de la chaîne ne se voyait qu'au silence du bot.
 *
 * Une variable vide (`TWITCH_CHANNEL=`) vaut absente : c'est ce qu'on écrit
 * dans un `.env` pour désactiver quelque chose.
 */

/** Adresses d'écoute qui restent sur la machine : pas de mot de passe exigé. */
const LOCALES = new Set(['127.0.0.1', 'localhost', '::1']);

/** Longueur minimale de `PANEL_TOKEN`. */
export const PANEL_TOKEN_MIN = 32;

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

const integer = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? fallback : value),
    z.coerce
      .number({ message: 'nombre entier attendu' })
      .int({ message: 'nombre entier attendu' })
      .min(min, { message: `entre ${min} et ${max}` })
      .max(max, { message: `entre ${min} et ${max}` }),
  );

/** Liste séparée par des virgules ; vide ou absente → liste vide. */
const commaList = optionalText.transform((value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const ConfigSchema = z
  .object({
    PORT: integer(1, 65535, 3001),
    HOST: optionalText.transform((value) => value ?? '127.0.0.1'),
    /** Nom de chaîne Twitch : 3 à 25 lettres, chiffres ou `_`, `#` toléré. */
    TWITCH_CHANNEL: optionalText.pipe(
      z
        .string()
        .regex(/^#?[A-Za-z0-9_]{3,25}$/, { message: 'nom de chaîne Twitch attendu (3 à 25 lettres, chiffres ou _)' })
        .transform((value) => value.replace(/^#/, '').toLowerCase())
        .optional(),
    ),
    TWITCH_BOT_TOKEN: optionalText,
    TWITCH_BOT_USERNAME: optionalText.transform((value) => value?.toLowerCase()),
    LANGUE: optionalText.pipe(
      z.enum(['fr', 'en'], { message: '« fr » ou « en » attendu' }).optional(),
    ).transform((value) => value ?? 'fr'),
    /** Comptes ignorés, en plus des bots courants. `@` et majuscules tolérés. */
    BOTS_IGNORES: commaList.transform((logins) => [
      ...new Set([...DEFAULT_IGNORED_BOTS, ...logins.map((login) => login.replace(/^@/, '').toLowerCase())]),
    ]),
    PANEL_TOKEN: optionalText,
    /** Hôtes acceptés en plus de la machine locale. */
    HOTES_AUTORISES: commaList,
    /** Joueurs sans participation depuis ce nombre de mois : effacés au démarrage. */
    PURGE_MOIS: integer(1, 120, 12),
    DB_PATH: optionalText,
  })
  .superRefine((config, context) => {
    if (config.PANEL_TOKEN !== undefined && config.PANEL_TOKEN.length < PANEL_TOKEN_MIN) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PANEL_TOKEN'],
        message: `au moins ${PANEL_TOKEN_MIN} caractères`,
      });
    }
    // Ouvert au réseau sans mot de passe, n'importe qui sur le réseau pilote le
    // jeu. Le SNCF se contentait d'un avertissement dans la bannière.
    if (!LOCALES.has(config.HOST) && config.PANEL_TOKEN === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HOST'],
        message: `écoute ouverte au réseau : PANEL_TOKEN (au moins ${PANEL_TOKEN_MIN} caractères) est obligatoire`,
      });
    }
    if (config.TWITCH_BOT_TOKEN !== undefined && config.TWITCH_BOT_USERNAME === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TWITCH_BOT_USERNAME'],
        message: 'obligatoire avec TWITCH_BOT_TOKEN (login du compte bot)',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration invalide :\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
}

/**
 * Lit et valide l'environnement ; lève `ConfigError` avec **tous** les
 * problèmes d'un coup. Un secret n'est jamais recopié dans le message.
 */
export function lireConfig(env: Record<string, string | undefined>): Config {
  const result = ConfigSchema.safeParse(env);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? '?');
      const secret = name === 'PANEL_TOKEN' || name === 'TWITCH_BOT_TOKEN';
      const shown = secret ? '***' : JSON.stringify(env[name] ?? '');
      return `${name}=${shown} : ${issue.message}`;
    }),
  );
}

/** Vrai si l'écoute reste sur la machine. */
export function ecouteLocale(host: string): boolean {
  return LOCALES.has(host);
}
