import type { Joueur } from './types.js';
import type { Player, Store } from './store.js';

/**
 * Points et victoires (inspiré de `sncf/src/bets/ledger.ts`, sans les mises).
 *
 * Le classement trie **par victoires, puis par points** : trié aux points
 * seuls, `!oubliemoi` aurait été rentable dans un jeu à mises (le SNCF l'a
 * payé) ; trié aux victoires, effacer son compte ne fait que perdre.
 *
 * Chaque changement est écrit en base aussitôt : un arrêt brutal ne perd rien.
 */
export class Scores {
  readonly #joueurs = new Map<string, Player>();
  readonly #store: Store | undefined;
  readonly #now: () => Date;

  constructor(options: { store?: Store; now?: () => Date } = {}) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    for (const player of this.#store?.loadPlayers() ?? []) this.#joueurs.set(player.userId, player);
  }

  /**
   * Note la participation d'un joueur et met son pseudo à jour (il peut
   * changer entre deux streams ; l'identifiant, non).
   */
  joueur(joueur: Joueur): Player {
    const now = this.#now().toISOString();
    const existant = this.#joueurs.get(joueur.userId);
    const player: Player = existant
      ? { ...existant, login: joueur.login, displayName: joueur.displayName, lastSeen: now }
      : {
          userId: joueur.userId,
          login: joueur.login,
          displayName: joueur.displayName,
          points: 0,
          wins: 0,
          played: 0,
          lastSeen: now,
        };
    this.#ecrire(player);
    return player;
  }

  get(userId: string): Player | null {
    return this.#joueurs.get(userId) ?? null;
  }

  /** Crédite une manche jouée : des points, et une victoire si `victoire`. */
  award(joueur: Joueur, points: number, options: { victoire?: boolean } = {}): Player {
    const base = this.joueur(joueur);
    const player: Player = {
      ...base,
      points: base.points + Math.max(0, Math.round(points)),
      wins: base.wins + (options.victoire ? 1 : 0),
      played: base.played + 1,
    };
    this.#ecrire(player);
    return player;
  }

  /** Les `n` premiers : victoires, puis points, puis ordre alphabétique (stable). */
  classement(n = 5): Player[] {
    return [...this.#joueurs.values()]
      .filter((p) => p.played > 0)
      .sort((a, b) => b.wins - a.wins || b.points - a.points || a.displayName.localeCompare(b.displayName))
      .slice(0, n);
  }

  /** `!oubliemoi` : points, victoires, tout. Un joueur qui revient repart de zéro. */
  forget(userId: string): void {
    this.#joueurs.delete(userId);
    this.#store?.forgetPlayer(userId);
  }

  #ecrire(player: Player): void {
    this.#joueurs.set(player.userId, player);
    this.#store?.savePlayer(player);
  }
}
