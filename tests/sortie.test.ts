/**
 * Sortie : tout message envoyé passe par là (section 6 du brief).
 *
 * L'horloge est simulée : attendre 30 s ne coûte rien, et la fenêtre de
 * Twitch se vérifie message par message.
 */

import { describe, expect, it } from 'vitest';
import { FENETRE_MS, Sortie, citer, pseudo } from '../src/chat/sortie.js';
import type { ChatLine, ChatTransport, EtatAuth, Retrait } from '../src/types.js';

class FauxTransport implements ChatTransport {
  readonly loginBot = 'bot';
  etat: EtatAuth = 'authenticated';
  connecte = true;
  eleve = false;
  readonly envois: Array<{ texte: string; at: number }> = [];
  constructor(readonly horloge: { t: number }) {}
  async connecter(): Promise<void> {}
  async fermer(): Promise<void> {}
  envoyer(texte: string): void {
    this.envois.push({ texte, at: this.horloge.t });
  }
  surMessage(_handler: (line: ChatLine) => void): void {}
  surRetrait(_handler: (retrait: Retrait) => void): void {}
}

function monter(options: { maxFile?: number; intervalleMs?: number } = {}) {
  const horloge = { t: 0 };
  const transport = new FauxTransport(horloge);
  const avertissements: string[] = [];
  const infos: string[] = [];
  const sortie = new Sortie({
    transport,
    logger: { info: (m) => infos.push(m), warn: (m) => avertissements.push(m) },
    maintenant: () => horloge.t,
    attendre: async (ms) => {
      horloge.t += ms;
    },
    ...options,
  });
  return { horloge, transport, sortie, avertissements, infos };
}

/** Plus grand nombre d'envois dans une fenêtre glissante de 30 s. */
function picSur30s(instants: number[]): number {
  let pic = 0;
  for (const debut of instants) pic = Math.max(pic, instants.filter((t) => t >= debut && t < debut + FENETRE_MS).length);
  return pic;
}

describe('limites de Twitch', () => {
  it('30 messages demandés d’un coup : jamais plus de 20 sur 30 s, file bornée à 20', async () => {
    const { transport, sortie, avertissements } = monter();
    let fileMax = 0;
    const envois: Array<Promise<void>> = [];
    for (let i = 0; i < 30; i++) {
      envois.push(sortie.dire(`annonce ${i}`));
      fileMax = Math.max(fileMax, sortie.enAttente);
    }
    await Promise.all(envois);

    expect(fileMax).toBeLessThanOrEqual(20);
    expect(picSur30s(transport.envois.map((e) => e.at))).toBeLessThanOrEqual(20);
    // Les 30 arrivent avant le premier envoi : la file en garde 20, et dit
    // lesquelles elle abandonne.
    expect(transport.envois).toHaveLength(20);
    expect(avertissements.filter((w) => w.includes('annonce abandonnée'))).toHaveLength(10);
  });

  it('étale sur plusieurs fenêtres ce qui dépasse 20', async () => {
    const { transport, sortie } = monter({ maxFile: 100 });
    await Promise.all(Array.from({ length: 45 }, (_, i) => sortie.dire(`annonce ${i}`)));
    const instants = transport.envois.map((e) => e.at);
    expect(instants).toHaveLength(45);
    expect(picSur30s(instants)).toBeLessThanOrEqual(20);
  });

  it('attend au moins une seconde entre deux messages', async () => {
    const { transport, sortie } = monter();
    await Promise.all([sortie.dire('a'), sortie.dire('b'), sortie.dire('c')]);
    const at = transport.envois.map((e) => e.at);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1000);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(1000);
  });

  it('monte à 100 sur 30 s quand le bot est modérateur, VIP ou diffuseur', async () => {
    const { transport, sortie } = monter({ maxFile: 200, intervalleMs: 0 });
    transport.eleve = true;
    await Promise.all(Array.from({ length: 60 }, (_, i) => sortie.dire(`annonce ${i}`)));
    expect(transport.envois.every((e) => e.at === 0)).toBe(true);
  });

  it('sacrifie les réponses avant les annonces quand la file déborde', async () => {
    const { transport, sortie, avertissements } = monter({ maxFile: 3 });
    transport.connecte = false; // tout reste en file
    void sortie.dire('réponse A', { essentiel: false });
    void sortie.dire('annonce 1');
    void sortie.dire('annonce 2');
    void sortie.dire('annonce 3');
    const fin = sortie.dire('réponse B', { essentiel: false });
    transport.connecte = true;
    await fin;

    expect(transport.envois.map((e) => e.texte)).toEqual(['annonce 1', 'annonce 2', 'annonce 3']);
    expect(avertissements.filter((w) => w.includes('réponse abandonnée'))).toHaveLength(2);
  });

  it('attend la connexion plutôt que de perdre le message', async () => {
    const { transport, sortie, horloge } = monter();
    transport.connecte = false;
    const fin = sortie.dire('La manche en cours a été interrompue.');
    await Promise.resolve();
    expect(transport.envois).toHaveLength(0);
    horloge.t += 1;
    transport.connecte = true;
    await fin;
    expect(transport.envois).toHaveLength(1);
  });
});

describe('anti-doublon', () => {
  it('deux messages identiques à 5 s d’écart : le second prend une autre formulation', async () => {
    const { transport, sortie, horloge } = monter();
    await sortie.dire(['Manche terminée.', 'Fin de la manche.']);
    horloge.t += 5000;
    await sortie.dire(['Manche terminée.', 'Fin de la manche.']);
    expect(transport.envois.map((e) => e.texte)).toEqual(['Manche terminée.', 'Fin de la manche.']);
  });

  it('sans autre formulation : un suffixe discret', async () => {
    const { transport, sortie, horloge } = monter();
    await sortie.dire('Manche terminée.');
    horloge.t += 5000;
    await sortie.dire('Manche terminée.');
    expect(transport.envois[1]!.texte).not.toBe(transport.envois[0]!.texte);
  });

  it('après 30 s, la formulation habituelle revient', async () => {
    const { transport, sortie, horloge } = monter();
    await sortie.dire(['Manche terminée.', 'Fin de la manche.']);
    horloge.t += 31_000;
    await sortie.dire(['Manche terminée.', 'Fin de la manche.']);
    expect(transport.envois[1]!.texte).toBe('Manche terminée.');
  });
});

describe('injection par le texte', () => {
  it('un retour à la ligne ne peut pas émettre une seconde commande IRC', async () => {
    const { transport, sortie } = monter();
    await sortie.dire(`x${String.fromCharCode(13, 10)}PRIVMSG #ailleurs :/ban victime`);
    expect(transport.envois).toHaveLength(1);
    expect(transport.envois[0]!.texte).not.toMatch(/[\r\n]/);
  });

  it('une réponse qui reprend « /ban alice » ne commence jamais par / ni .', async () => {
    const { transport, sortie } = monter();
    await sortie.dire(citer('/ban alice'));
    await sortie.dire(citer('.timeout alice 600'));
    for (const { texte } of transport.envois) expect(texte).not.toMatch(/^[/.]/);
  });

  it('un long message est découpé à 480 caractères, aux espaces', async () => {
    const { transport, sortie } = monter();
    await sortie.dire(Array.from({ length: 200 }, (_, i) => `mot${i}`).join(' '));
    expect(transport.envois.length).toBeGreaterThan(1);
    for (const { texte } of transport.envois) expect([...texte].length).toBeLessThanOrEqual(480);
  });
});

describe('citations et pseudos', () => {
  it('coupe un texte du chat à 40 caractères', () => {
    expect([...citer('a'.repeat(100))]).toHaveLength(40);
    expect(citer('a'.repeat(100)).endsWith('…')).toBe(true);
    expect(citer('court')).toBe('court');
  });

  it('nettoie un texte cité', () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(citer(`${rlo}salut`)).toBe('salut');
  });

  it('coupe un pseudo à 25 caractères', () => {
    expect([...pseudo('b'.repeat(40))]).toHaveLength(25);
  });
});

describe('lecture seule', () => {
  it('n’envoie rien, et journalise ce qui aurait été dit', async () => {
    for (const etat of ['anonymous', 'refused'] as const) {
      const { transport, sortie, infos } = monter();
      transport.etat = etat;
      await sortie.dire('Bonjour');
      expect(transport.envois).toHaveLength(0);
      expect(infos.some((m) => m.includes('Bonjour'))).toBe(true);
    }
  });
});

describe('file d’envoi', () => {
  // Un message demandé pendant que la boucle d'envoi se termine (sa promesse est
  // résolue, le nettoyage pas encore fait) restait en file jusqu'au message suivant.
  it.each(Array.from({ length: 12 }, (_, i) => i))('un message demandé %i micro-tâches après le précédent part aussi', async (n) => {
    const { transport, sortie } = monter({ intervalleMs: 0 });
    void sortie.dire('premier');
    for (let i = 0; i < n; i++) await Promise.resolve();
    void sortie.dire('second');
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(transport.envois.map((e) => e.texte)).toEqual(['premier', 'second']);
  });
});
