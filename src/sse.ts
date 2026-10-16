import type { ServerResponse } from 'node:http';

/**
 * Diffusion vers l'overlay OBS en Server-Sent Events (copié de
 * `sncf/src/server/sse.ts`, rendu générique).
 *
 * Pourquoi SSE et pas WebSocket : le flux est à sens unique (serveur → overlay),
 * la reconnexion est native côté navigateur, et une source navigateur OBS qu'on
 * relance doit retrouver l'état immédiatement — ce que fait l'envoi de l'état
 * courant à la connexion.
 *
 * La vue est **recalculée à chaque envoi**, jamais mise en cache : un compte à
 * rebours servi depuis une copie est faux de plusieurs secondes (décision 11
 * du SNCF).
 */
export class SseHub<V> {
  readonly #clients = new Set<ServerResponse>();
  readonly #view: () => V;
  readonly #coalesceMs: number;
  #pending: NodeJS.Timeout | null = null;

  constructor(view: () => V, options: { coalesceMs?: number } = {}) {
    this.#view = view;
    this.#coalesceMs = options.coalesceMs ?? 250;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /**
   * Rediffuse la vue. Les appels sont regroupés : cinquante personnes qui
   * répondent en même temps ne déclenchent pas cinquante diffusions.
   */
  publish(): void {
    if (this.#pending) return;
    this.#pending = setTimeout(() => {
      this.#pending = null;
      this.#send(this.#view());
    }, this.#coalesceMs);
    this.#pending.unref?.();
  }

  /** Diffuse tout de suite (fin de manche, arrêt). */
  publishNow(): void {
    if (this.#pending) clearTimeout(this.#pending);
    this.#pending = null;
    this.#send(this.#view());
  }

  /** Branche une nouvelle source navigateur et lui sert l'état courant. */
  subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // OBS charge parfois la page dans un contexte sans origine : sans cette
      // entête, l'overlay restait muet sans erreur visible (payé dans le SNCF).
      // La vue est ce qui s'affiche à l'antenne : rien de secret n'y passe.
      'Access-Control-Allow-Origin': '*',
      // Coupe la bufferisation d'un éventuel reverse-proxy.
      'X-Accel-Buffering': 'no',
    });
    // Demande au navigateur de retenter après 2 s en cas de coupure.
    response.write('retry: 2000\n\n');

    this.#clients.add(response);
    response.on('close', () => this.#clients.delete(response));
    this.#write(response, this.#view());
  }

  /** Battement régulier : garde la connexion ouverte à travers les proxys. */
  heartbeat(): void {
    for (const client of this.#clients) client.write(': ping\n\n');
  }

  closeAll(): void {
    if (this.#pending) clearTimeout(this.#pending);
    this.#pending = null;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
  }

  #send(view: V): void {
    for (const client of this.#clients) this.#write(client, view);
  }

  #write(client: ServerResponse, view: V): void {
    client.write(`event: state\ndata: ${JSON.stringify(view)}\n\n`);
  }
}
