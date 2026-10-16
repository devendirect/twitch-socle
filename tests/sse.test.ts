/** Flux de l'overlay, et contrôle de la vérification `innerHTML`. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SseHub } from '../src/sse.js';
import { chercherHtmlBrut } from '../src/verif.js';

/** Réponse HTTP minimale : on lit ce qui est écrit. */
function fausseReponse() {
  const ecrit: string[] = [];
  const reponse = {
    writeHead: () => reponse,
    write: (chunk: string) => ecrit.push(chunk),
    on: () => reponse,
    end: () => {},
  };
  return { reponse: reponse as unknown as ServerResponse, ecrit };
}

const etats = (ecrit: string[]) =>
  ecrit.filter((c) => c.startsWith('event: state')).map((c) => JSON.parse(c.split('data: ')[1]!) as { s: number });

describe('SseHub', () => {
  it('sert l’état courant dès la connexion, recalculé', () => {
    let secondes = 30;
    const hub = new SseHub(() => ({ s: secondes }));
    secondes = 12;
    const { reponse, ecrit } = fausseReponse();
    hub.subscribe(reponse);
    expect(etats(ecrit)).toEqual([{ s: 12 }]);
  });

  it('regroupe les diffusions rapprochées', () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const hub = new SseHub(() => ({ s: ++n }), { coalesceMs: 250 });
      const { reponse, ecrit } = fausseReponse();
      hub.subscribe(reponse);
      for (let i = 0; i < 50; i++) hub.publish();
      vi.advanceTimersByTime(300);
      expect(etats(ecrit)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('chercherHtmlBrut', () => {
  it('trouve innerHTML dans le code, pas dans les commentaires', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'socle-'));
    try {
      writeFileSync(
        path.join(d, 'page.js'),
        ['// innerHTML est interdit', '/* outerHTML aussi */', 'const url = "http://x";', 'el.innerHTML = pseudo;'].join('\n'),
      );
      writeFileSync(path.join(d, 'autorise.js'), 'el.innerHTML = "";');
      expect(chercherHtmlBrut(d, { 'autorise.js': 'vidage, sans donnée' })).toEqual(['page.js:4 : el.innerHTML = pseudo;']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
