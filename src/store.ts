import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Persistance SQLite via `node:sqlite` (inspiré de `sncf/src/store/store.ts`).
 *
 * Trois tables, et le minimum (section 8 du brief) :
 *
 *   players   `user-id`, login, pseudo affiché, points, victoires, manches
 *             jouées, date de dernière participation ;
 *   rounds    les manches : identifiant, jeu, début, fin, statut. Pour qu'un
 *             redémarrage en pleine manche se voie ;
 *   reglages  ce que le streamer règle au panneau et qui doit survivre à un
 *             redémarrage (le thème de l'overlay, par exemple). Clé, valeur :
 *             le jeu valide ce qu'il y range. Jamais rien qui vienne du chat.
 *
 * **Aucun message du chat n'est enregistré.** Requêtes toujours préparées.
 */

/**
 * `node:sqlite` est chargé par `require` et non par `import` : Vite — donc
 * Vitest — retire le préfixe « node: » puis cherche un paquet « sqlite » sur le
 * disque, et l'import statique casse toute la suite de tests.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  user_id      TEXT PRIMARY KEY,
  login        TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  points       INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  played       INTEGER NOT NULL DEFAULT 0,
  last_seen    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id         TEXT PRIMARY KEY,
  game       TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reglages (
  cle    TEXT PRIMARY KEY,
  valeur TEXT NOT NULL
);
`;

export interface Player {
  userId: string;
  login: string;
  displayName: string;
  points: number;
  wins: number;
  played: number;
  /** Dernière participation (ISO). Sert à la purge. */
  lastSeen: string;
}

export type StatutManche = 'ouverte' | 'terminee' | 'annulee' | 'interrompue';

export class Store {
  readonly #db: InstanceType<typeof DatabaseSync>;

  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.#db = new DatabaseSync(file);
    // WAL : l'écriture ne bloque pas la lecture, et une coupure brutale en
    // plein live laisse la base cohérente.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(SCHEMA);
  }

  // ─── Joueurs ───────────────────────────────────────────────────────────────

  loadPlayers(): Player[] {
    return this.#db
      .prepare('SELECT user_id, login, display_name, points, wins, played, last_seen FROM players')
      .all()
      .map((row: Record<string, unknown>) => ({
        userId: String(row['user_id']),
        login: String(row['login']),
        displayName: String(row['display_name']),
        points: Number(row['points']),
        wins: Number(row['wins']),
        played: Number(row['played']),
        lastSeen: String(row['last_seen']),
      }));
  }

  savePlayer(player: Player): void {
    this.#db
      .prepare(`
        INSERT INTO players (user_id, login, display_name, points, wins, played, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          login        = excluded.login,
          display_name = excluded.display_name,
          points       = excluded.points,
          wins         = excluded.wins,
          played       = excluded.played,
          last_seen    = excluded.last_seen
      `)
      .run(
        player.userId,
        player.login,
        player.displayName,
        player.points,
        player.wins,
        player.played,
        player.lastSeen,
      );
  }

  /** `!oubliemoi` : le joueur disparaît de la base. */
  forgetPlayer(userId: string): void {
    this.#db.prepare('DELETE FROM players WHERE user_id = ?').run(userId);
  }

  /**
   * Durée de conservation : efface les joueurs sans participation depuis
   * `before`. Les manches restent : elles ne disent rien de personne.
   *
   * @returns le nombre de joueurs effacés
   */
  purgeInactive(before: Date): number {
    return Number(this.#db.prepare('DELETE FROM players WHERE last_seen < ?').run(before.toISOString()).changes);
  }

  // ─── Manches ───────────────────────────────────────────────────────────────

  openRound(id: string, game: string, at: Date): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO rounds (id, game, started_at, ended_at, status) VALUES (?, ?, ?, NULL, ?)')
      .run(id, game, at.toISOString(), 'ouverte' satisfies StatutManche);
  }

  closeRound(id: string, status: Exclude<StatutManche, 'ouverte'>, at: Date): void {
    this.#db.prepare('UPDATE rounds SET ended_at = ?, status = ? WHERE id = ?').run(at.toISOString(), status, id);
  }

  /**
   * Au démarrage : les manches restées ouvertes ont été coupées par un arrêt
   * brutal. Elles passent « interrompues », sans points.
   *
   * @returns le nombre de manches interrompues
   */
  interruptOpenRounds(game: string, at: Date): number {
    return Number(
      this.#db
        .prepare('UPDATE rounds SET ended_at = ?, status = ? WHERE game = ? AND status = ?')
        .run(at.toISOString(), 'interrompue' satisfies StatutManche, game, 'ouverte' satisfies StatutManche).changes,
    );
  }

  roundStatus(id: string): StatutManche | null {
    const row = this.#db.prepare('SELECT status FROM rounds WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? (String(row['status']) as StatutManche) : null;
  }

  // ─── Réglages ──────────────────────────────────────────────────────────────

  /** Réglage enregistré, ou `null`. Le jeu revalide ce qu'il relit. */
  lireReglage(cle: string): string | null {
    const row = this.#db.prepare('SELECT valeur FROM reglages WHERE cle = ?').get(cle) as
      | Record<string, unknown>
      | undefined;
    return row ? String(row['valeur']) : null;
  }

  ecrireReglage(cle: string, valeur: string): void {
    this.#db
      .prepare('INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur')
      .run(cle, valeur);
  }

  // ─── Entretien ─────────────────────────────────────────────────────────────

  /**
   * Rapatrie le journal WAL dans le fichier principal. Sans cela, copier la
   * base seule donne une sauvegarde vide (payé dans le SNCF).
   */
  checkpoint(): void {
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Sauvegarde cohérente, serveur allumé : `VACUUM INTO` lit sous une
   * transaction, WAL compris. SQLite refuse d'écraser un fichier existant.
   */
  backup(destination: string): void {
    const target = path.resolve(destination);
    if (existsSync(target)) {
      throw new Error(`La sauvegarde ${target} existe déjà — SQLite refuse de l'écraser.`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    this.#db.prepare('VACUUM INTO ?').run(target);
  }

  close(): void {
    try {
      this.checkpoint();
    } catch {
      // Une base déjà fermée ne doit pas empêcher l'arrêt du serveur.
    }
    this.#db.close();
  }

  /** Toutes les valeurs texte de la base : pour vérifier qu'aucun message n'y est. */
  allText(): string[] {
    const texts: string[] = [];
    for (const table of ['players', 'rounds', 'reglages']) {
      for (const row of this.#db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
        for (const value of Object.values(row)) if (typeof value === 'string') texts.push(value);
      }
    }
    return texts;
  }
}
