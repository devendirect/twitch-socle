/**
 * Horloges injectables.
 *
 * En mode fixtures, l'heure réelle n'a aucun rapport avec les horaires figés du
 * TGV 8537 (14:15 le 20/09/2026). Une horloge accélérée permet de voir l'overlay
 * s'animer pour de vrai — départ, gares qui défilent, résolution — en une
 * minute et demie au lieu de trois heures.
 */
export interface Clock {
  now(): Date;
  /** Décrit l'horloge pour le panneau streamer. */
  describe(): string;
  /**
   * Facteur d'accélération. Le compte à rebours de l'overlay en a besoin : le
   * navigateur, lui, tourne toujours en temps réel, et décompterait 120 fois
   * trop lentement en mode fixtures.
   */
  readonly speed?: number;
  /**
   * Ré-ancre l'horloge sur son origine. Sans cela, en mode accéléré, le temps
   * virtuel file dès le démarrage du serveur : ouvrir le panneau et cliquer
   * suffit à « rater » le train. L'horloge système, elle, ignore cet appel.
   */
  reset?(): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  describe: () => 'heure système',
  speed: 1,
};

export class AcceleratedClock implements Clock {
  readonly #origin: number;
  readonly #speed: number;
  #startedAt: number;

  get speed(): number {
    return this.#speed;
  }

  constructor(startIso: string, speed = 120) {
    this.#origin = new Date(startIso).getTime();
    this.#startedAt = Date.now();
    this.#speed = speed;
  }

  now(): Date {
    const elapsed = Date.now() - this.#startedAt;
    return new Date(this.#origin + elapsed * this.#speed);
  }

  reset(): void {
    this.#startedAt = Date.now();
  }

  describe(): string {
    return `horloge accélérée ×${this.#speed} (départ ${new Date(this.#origin).toISOString()})`;
  }
}
