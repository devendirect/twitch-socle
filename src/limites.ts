/**
 * Limite de fréquence générique : `max` actions par `fenetreMs`, par clé.
 *
 * Par personne (une clé par `user-id`) : `!points` répété en boucle ne doit
 * pas remplir la file du bot. Globale (une seule clé) : un raid qui tape tous
 * `!classement` en même temps n'obtient qu'une réponse. La file d'envoi
 * bornée, elle, est dans `chat/sortie.ts`.
 *
 * Horloge injectée : vérifiable sans attendre.
 */
export class LimiteFrequence {
  readonly #max: number;
  readonly #fenetre: number;
  readonly #maintenant: () => number;
  readonly #historique = new Map<string, number[]>();

  constructor(options: { max: number; fenetreMs: number; maintenant?: () => number }) {
    this.#max = options.max;
    this.#fenetre = options.fenetreMs;
    this.#maintenant = options.maintenant ?? Date.now;
  }

  /** Vrai si l'action est permise — et la compte. Faux sinon, sans la compter. */
  autoriser(cle = '*'): boolean {
    const now = this.#maintenant();
    const recents = (this.#historique.get(cle) ?? []).filter((at) => now - at < this.#fenetre);
    if (recents.length >= this.#max) {
      this.#historique.set(cle, recents);
      return false;
    }
    recents.push(now);
    this.#historique.set(cle, recents);
    return true;
  }

  /** Oublie une clé (`!oubliemoi`). */
  oublier(cle: string): void {
    this.#historique.delete(cle);
  }
}
