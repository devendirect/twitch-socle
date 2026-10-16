/**
 * Vote du chat : N options numérotées, une fenêtre, `!vote 2`, un tirage en cas
 * d'égalité.
 *
 * Copié du jeu SNCF, où il choisit une gare puis un train. Il ne connaît que
 * des libellés et transporte une charge utile opaque : l'appelant sait ce qu'il
 * y a mis, le vote n'a pas à le savoir. Le sujet est une simple étiquette
 * (`'gare'`, `'prenom'`…) que les surfaces affichent.
 */

/** Une option soumise au chat. `payload` ne regarde que l'appelant. */
export interface VoteOption<T = unknown> {
  /** Ligne principale : « TGV INOUI 8537 », « Bordeaux Saint-Jean ». */
  title: string;
  /** Ligne secondaire : « → Paris Montparnasse · 14:41 », « 3 propositions ». */
  subtitle: string;
  payload: T;
}

export type VoteReason = 'votes' | 'tie' | 'random';

export interface VoteResult<T = unknown> {
  winner: VoteOption<T>;
  rank: number;
  votes: number;
  total: number;
  /**
   * Comment le gagnant a été désigné. Le chat a le droit de savoir qu'il a été
   * tiré au sort : annoncer « le chat a choisi » alors que personne n'a voté
   * serait un mensonge, et il se verrait.
   */
  reason: VoteReason;
}

export interface VoteView {
  /** Ce sur quoi porte le vote, pour que les surfaces sachent quoi écrire. */
  subject: string;
  endsAt: string;
  secondsLeft: number;
  total: number;
  candidates: Array<{
    rank: number;
    title: string;
    subtitle: string;
    votes: number;
    /** Part du total, 0 si personne n'a encore voté. */
    share: number;
  }>;
}

export interface RankedVoteOptions<T> {
  subject: string;
  options: Array<VoteOption<T>>;
  durationMs: number;
  /**
   * Horloge injectée pour les tests.
   *
   * ⚠️ Lui passer le TEMPS RÉEL, jamais une horloge accélérée : dans le SNCF,
   * en mode fixtures (×120), le décompte affiché tombait à zéro en deux
   * secondes pendant que la fenêtre restait ouverte.
   */
  now?: () => Date;
  /** Tirage injecté, pour que « au hasard » reste vérifiable. */
  random?: () => number;
}

export class RankedVote<T = unknown> {
  readonly subject: string;
  readonly options: ReadonlyArray<VoteOption<T>>;
  readonly endsAt: Date;

  /** Un vote par personne, remplaçable : `userId → rang`. */
  readonly #ballots = new Map<string, number>();
  readonly #now: () => Date;
  readonly #random: () => number;
  #closed = false;

  constructor(options: RankedVoteOptions<T>) {
    if (options.options.length === 0) {
      throw new Error('Un vote a besoin d’au moins une option.');
    }
    this.subject = options.subject;
    this.options = [...options.options];
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.endsAt = new Date(this.#now().getTime() + options.durationMs);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get total(): number {
    return this.#ballots.size;
  }

  /** Vrai quand la fenêtre est écoulée — le serveur n'a plus qu'à clore. */
  expired(): boolean {
    return this.#now().getTime() >= this.endsAt.getTime();
  }

  /**
   * Enregistre un vote. Le rang est celui affiché au chat, de 1 à N.
   *
   * Revoter est autorisé et remplace le choix précédent : quelqu'un qui se
   * trompe de chiffre n'a aucune raison d'être puni, et l'interdire n'empêche
   * rien — il suffirait d'un second compte.
   */
  cast(userId: string, rank: number): 'ok' | 'changed' | 'invalid' | 'closed' {
    if (this.#closed || this.expired()) return 'closed';
    if (!Number.isInteger(rank) || rank < 1 || rank > this.options.length) return 'invalid';

    const previous = this.#ballots.get(userId);
    this.#ballots.set(userId, rank);
    return previous === undefined || previous === rank ? 'ok' : 'changed';
  }

  /** Nombre de voix par rang, index 0 = rang 1. */
  tally(): number[] {
    const counts = new Array<number>(this.options.length).fill(0);
    for (const rank of this.#ballots.values()) counts[rank - 1] = (counts[rank - 1] ?? 0) + 1;
    return counts;
  }

  view(): VoteView {
    const counts = this.tally();
    const total = this.total;
    const left = Math.max(0, this.endsAt.getTime() - this.#now().getTime());

    return {
      subject: this.subject,
      endsAt: this.endsAt.toISOString(),
      secondsLeft: Math.ceil(left / 1000),
      total,
      candidates: this.options.map((option, index) => ({
        rank: index + 1,
        title: option.title,
        subtitle: option.subtitle,
        votes: counts[index] ?? 0,
        share: total > 0 ? (counts[index] ?? 0) / total : 0,
      })),
    };
  }

  /**
   * Clôt le vote et désigne un gagnant.
   *
   * Trois cas, et chacun est nommé dans le résultat plutôt que maquillé :
   *
   *   - des voix, un vainqueur net → `votes`
   *   - des voix, une égalité en tête → `tie`, tirage parmi les ex æquo
   *   - aucune voix → `random`, tirage parmi toutes les options
   *
   * Le dernier cas n'est pas un repli honteux : c'est le comportement demandé.
   * Une partie doit pouvoir démarrer même si le chat est silencieux — un stream
   * qui s'arrête faute de votes serait pire que n'importe quel tirage.
   */
  close(): VoteResult<T> {
    this.#closed = true;
    const counts = this.tally();
    const total = this.total;

    if (total === 0) {
      const index = this.#pick(this.options.map((_, i) => i));
      return { winner: this.options[index]!, rank: index + 1, votes: 0, total: 0, reason: 'random' };
    }

    const best = Math.max(...counts);
    const leaders = counts.flatMap((count, index) => (count === best ? [index] : []));
    const index = leaders.length === 1 ? leaders[0]! : this.#pick(leaders);

    return {
      winner: this.options[index]!,
      rank: index + 1,
      votes: best,
      total,
      reason: leaders.length === 1 ? 'votes' : 'tie',
    };
  }

  #pick(indexes: number[]): number {
    return indexes[Math.floor(this.#random() * indexes.length)] ?? indexes[0]!;
  }
}
