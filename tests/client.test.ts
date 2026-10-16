/**
 * La connexion au chat Twitch (copié de `sncf/tests/chat-client.test.ts`).
 *
 * Le socket est remplacé par un faux, injecté via `createSocket` : on rejoue
 * exactement ce que Twitch envoie, y compris ce qu'on espère ne jamais voir —
 * un jeton refusé pendant un stream.
 *
 * Les tests d'envoi (file, limites, anti-doublon, découpage) ont suivi le code
 * dans `sortie.test.ts` ; ceux des bots ignorés, dans `entree.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { TwitchChatClient } from '../src/chat/client.js';
import { Sortie } from '../src/chat/sortie.js';
import type { Retrait } from '../src/types.js';

/** Socket de test : on inspecte ce qui sort, on injecte ce qui entre. */
export class FakeSocket {
  readonly sent: string[] = [];
  closed = false;
  readonly #handlers = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.#handlers.get(type) ?? [];
    list.push(handler);
    this.#handlers.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  emit(type: string, event?: unknown): void {
    for (const handler of this.#handlers.get(type) ?? []) handler(event);
  }

  /** Ce que Twitch pousse sur le fil, lignes séparées par CRLF. */
  receive(...lines: string[]): void {
    this.emit('message', { data: lines.join('\r\n') });
  }
}

const silent = { info: () => {}, warn: () => {} };

function connect(options: { token?: string; logger?: { info(m: string): void; warn(m: string): void } } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new TwitchChatClient({
    channel: 'devendirect',
    logger: options.logger ?? silent,
    ...(options.token ? { token: options.token } : {}),
    username: 'bot',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const started = client.connecter();
  sockets[0]!.emit('open');
  return { client, sockets, started };
}

const lectureSeule = (client: TwitchChatClient) => client.etat === 'anonymous' || client.etat === 'refused';

describe('poignée de main', () => {
  it('demande les capacités AVANT de s’authentifier', async () => {
    const { sockets, started } = connect({ token: 'abcd' });
    await started;
    const lines = sockets[0]!.sent;
    expect(lines[0]).toContain('CAP REQ');
    expect(lines.findIndex((l) => l.startsWith('PASS'))).toBeGreaterThan(0);
  });

  it('préfixe le jeton d’`oauth:` s’il manque', async () => {
    const { sockets, started } = connect({ token: 'abcd' });
    await started;
    expect(sockets[0]!.sent).toContain('PASS oauth:abcd');
  });

  it('ne le préfixe pas deux fois', async () => {
    const { sockets, started } = connect({ token: 'oauth:abcd' });
    await started;
    expect(sockets[0]!.sent).toContain('PASS oauth:abcd');
  });

  it('se connecte en anonyme sans jeton, et n’envoie aucun PASS', async () => {
    const { client, sockets, started } = connect();
    await started;
    expect(sockets[0]!.sent.some((l) => l.startsWith('PASS'))).toBe(false);
    expect(sockets[0]!.sent.some((l) => /^NICK justinfan\d+$/.test(l))).toBe(true);
    expect(client.etat).toBe('anonymous');
    expect(client.loginBot).toBeNull();
  });

  it('donne le login du bot quand il a un jeton', async () => {
    const { client, started } = connect({ token: 'abcd' });
    await started;
    expect(client.loginBot).toBe('bot');
  });
});

describe('état d’authentification', () => {
  it('reste « en attente » tant que Twitch n’a pas répondu', async () => {
    const { client, started } = connect({ token: 'abcd' });
    await started;
    expect(client.etat).toBe('pending');
    // Optimiste : on n'est pas en lecture seule tant que rien n'a été refusé.
    expect(lectureSeule(client)).toBe(false);
  });

  it('passe à « authentifié » sur GLOBALUSERSTATE', async () => {
    const { client, sockets, started } = connect({ token: 'abcd' });
    await started;
    sockets[0]!.receive('@display-name=MonBot :tmi.twitch.tv GLOBALUSERSTATE');
    expect(client.etat).toBe('authenticated');
  });

  it('passe à « refusé » sur un jeton expiré', async () => {
    const { client, sockets, started } = connect({ token: 'abcd' });
    await started;
    sockets[0]!.receive(':tmi.twitch.tv NOTICE * :Login authentication failed');
    expect(client.etat).toBe('refused');
    expect(lectureSeule(client)).toBe(true);
  });

  it('reconnaît aussi un jeton malformé', async () => {
    const { client, sockets, started } = connect({ token: 'abcd' });
    await started;
    sockets[0]!.receive(':tmi.twitch.tv NOTICE * :Improperly formatted auth');
    expect(client.etat).toBe('refused');
  });

  it('ne prend pas un avis ordinaire pour un refus', async () => {
    const { client, sockets, started } = connect({ token: 'abcd' });
    await started;
    sockets[0]!.receive(':tmi.twitch.tv NOTICE #devendirect :This room is now in slow mode.');
    expect(client.etat).toBe('pending');
  });
});

describe('après un refus', () => {
  it('se reconnecte en anonyme plutôt que de reboucler sur le jeton mort', async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets, started } = connect({ token: 'perime' });
      await started;
      sockets[0]!.receive(':tmi.twitch.tv NOTICE * :Login authentication failed');

      // Twitch ferme la connexion après un refus ; le client replanifie.
      sockets[0]!.emit('close');
      await vi.advanceTimersByTimeAsync(2000);
      sockets[1]!.emit('open');

      expect(sockets).toHaveLength(2);
      expect(sockets[1]!.sent.some((l) => l.startsWith('PASS'))).toBe(false);
      expect(sockets[1]!.sent.some((l) => /^NICK justinfan\d+$/.test(l))).toBe(true);
      expect(lectureSeule(client)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('n’envoie plus rien dans le chat', async () => {
    const { client, sockets, started } = connect({ token: 'perime' });
    await started;
    sockets[0]!.receive(':tmi.twitch.tv NOTICE * :Login authentication failed');

    await new Sortie({ transport: client, intervalleMs: 0 }).dire('La manche commence !');
    expect(sockets[0]!.sent.some((l) => l.startsWith('PRIVMSG'))).toBe(false);
  });
});

describe('tenue de la connexion', () => {
  it('répond au PING, faute de quoi Twitch coupe', async () => {
    const { sockets, started } = connect();
    await started;
    sockets[0]!.receive('PING :tmi.twitch.tv');
    expect(sockets[0]!.sent).toContain('PONG :tmi.twitch.tv');
  });

  it('se reconnecte à repli exponentiel, plafonné', async () => {
    vi.useFakeTimers();
    try {
      const { sockets, started } = connect();
      await started;
      for (let i = 0; i < 4; i++) {
        sockets.at(-1)!.emit('close');
        await vi.advanceTimersByTimeAsync(40_000);
        sockets.at(-1)!.emit('open');
      }
      expect(sockets.length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('se reconnecte quand Twitch envoie RECONNECT', async () => {
    vi.useFakeTimers();
    try {
      const { sockets, started } = connect();
      await started;
      sockets[0]!.receive(':tmi.twitch.tv RECONNECT');
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets[0]!.closed).toBe(true);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne se reconnecte pas après une fermeture demandée', async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets, started } = connect();
      await started;
      await client.fermer();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survit à un gestionnaire qui lève', async () => {
    const { client, sockets, started } = connect();
    await started;
    client.surMessage(() => {
      throw new Error('boum');
    });
    const vus: string[] = [];
    client.surMessage((line) => vus.push(line.text));

    sockets[0]!.receive('@user-id=1;display-name=Alice :alice!alice@alice.tmi.twitch.tv PRIVMSG #devendirect :!points');
    expect(vus).toEqual(['!points']);
  });

  it('écrit dans le bon salon', async () => {
    const { client, sockets, started } = connect({ token: 'abcd' });
    await started;
    client.envoyer('Bonjour');
    expect(sockets[0]!.sent).toContain('PRIVMSG #devendirect :Bonjour');
  });
});

describe('statut du bot dans le salon', () => {
  it('lit diffuseur, modérateur ou VIP dans USERSTATE', async () => {
    const { client, sockets, started } = connect({ token: 'abcd' });
    await started;
    expect(client.eleve).toBe(false);
    sockets[0]!.receive('@badges=vip/1;mod=0 :tmi.twitch.tv USERSTATE #devendirect');
    expect(client.eleve).toBe(true);
    sockets[0]!.receive('@badges=;mod=0 :tmi.twitch.tv USERSTATE #devendirect');
    expect(client.eleve).toBe(false);
  });
});

describe('refus de Twitch', () => {
  it('retient le dernier message refusé et le journalise', async () => {
    const warnings: string[] = [];
    const { client, sockets, started } = connect({
      token: 'oauth:abcdefgh12345678',
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    await started;

    expect(client.lastRefusal).toBeNull();
    sockets[0]!.receive(
      '@msg-id=msg_duplicate :tmi.twitch.tv NOTICE #devendirect :Your message was not sent because it is identical to the previous one you sent, less than 30 seconds ago.',
    );

    expect(client.lastRefusal?.msgId).toBe('msg_duplicate');
    expect(warnings.some((w) => w.includes('msg_duplicate'))).toBe(true);
  });

  it('ignore un avis qui n’est pas un refus', async () => {
    const { client, sockets, started } = connect({ token: 'oauth:abcdefgh12345678' });
    await started;
    sockets[0]!.receive('@msg-id=host_on :tmi.twitch.tv NOTICE #devendirect :Now hosting someone.');
    expect(client.lastRefusal).toBeNull();
  });
});

describe('jeton dans les journaux', () => {
  it('le masque, avec ou sans « oauth: »', async () => {
    const lines: string[] = [];
    const { client, sockets, started } = connect({
      token: 'oauth:secret0123456789',
      logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
    });
    // Un gestionnaire qui échoue en recopiant le jeton : son message est journalisé.
    client.surMessage(() => {
      throw new Error('PASS oauth:secret0123456789 refusé (secret0123456789)');
    });
    await started;
    sockets[0]!.receive(':a!a@a PRIVMSG #devendirect :!points');

    expect(lines.join('\n')).not.toContain('secret0123456789');
    expect(lines.join('\n')).toContain('***');
  });

  it('le masque aussi en cas d’erreur de connexion', async () => {
    const lines: string[] = [];
    const sockets: FakeSocket[] = [];
    const client = new TwitchChatClient({
      channel: 'devendirect',
      token: 'oauth:secret0123456789',
      username: 'bot',
      logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });
    const started = client.connecter();
    sockets[0]!.emit('error');
    await expect(started).rejects.toThrow();
    sockets[0]!.receive(':tmi.twitch.tv NOTICE * :Login authentication failed');
    expect(lines.join('\n')).not.toContain('secret0123456789');
    await client.fermer();
  });
});

describe('retraits de modération', () => {
  it('signale un message supprimé, un bannissement et une exclusion — pas un chat vidé', async () => {
    const { client, sockets, started } = connect();
    await started;
    const retraits: Retrait[] = [];
    client.surRetrait((r) => retraits.push(r));

    sockets[0]!.receive(
      '@login=alice;target-msg-id=abc-123 :tmi.twitch.tv CLEARMSG #devendirect :1987',
      '@room-id=1;target-user-id=42 :tmi.twitch.tv CLEARCHAT #devendirect :tricheur',
      '@ban-duration=600;room-id=1;target-user-id=43 :tmi.twitch.tv CLEARCHAT #devendirect :bavard',
      '@room-id=1 :tmi.twitch.tv CLEARCHAT #devendirect',
    );

    expect(retraits).toEqual([
      { type: 'message', messageId: 'abc-123' },
      { type: 'utilisateur', userId: '42', login: 'tricheur', dureeSecondes: null },
      { type: 'utilisateur', userId: '43', login: 'bavard', dureeSecondes: 600 },
    ]);
  });
});
