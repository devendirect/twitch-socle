/**
 * Entrée : tout message reçu passe par là (section 5 du brief). Les lignes
 * IRC brutes traversent le vrai `irc.ts`, comme en direct.
 *
 * Les caractères invisibles sont construits par code : écrits tels quels dans
 * un test, ils seraient illisibles à la relecture.
 */

import { describe, expect, it } from 'vitest';
import { Entree } from '../src/chat/entree.js';
import { parseIrcLine, toChatLine, DEFAULT_IGNORED_BOTS } from '../src/chat/irc.js';
import type { ChatLine, ChatTransport, MessageJoueur, Retrait } from '../src/types.js';

class FauxTransport implements ChatTransport {
  loginBot: string | null = 'mon_bot';
  readonly etat = 'authenticated' as const;
  readonly connecte = true;
  readonly eleve = false;
  readonly #messages: Array<(line: ChatLine) => void> = [];
  readonly #retraits: Array<(retrait: Retrait) => void> = [];
  async connecter(): Promise<void> {}
  async fermer(): Promise<void> {}
  envoyer(): void {}
  surMessage(handler: (line: ChatLine) => void): void {
    this.#messages.push(handler);
  }
  surRetrait(handler: (retrait: Retrait) => void): void {
    this.#retraits.push(handler);
  }
  /** Une ligne IRC telle que Twitch l'envoie. */
  irc(ligne: string): void {
    const line = toChatLine(parseIrcLine(ligne)!);
    if (line) for (const h of this.#messages) h(line);
  }
  retrait(r: Retrait): void {
    for (const h of this.#retraits) h(r);
  }
}

function monter(bots: readonly string[] = DEFAULT_IGNORED_BOTS) {
  const transport = new FauxTransport();
  const avertissements: string[] = [];
  const entree = new Entree({ transport, botsIgnores: bots, logger: { info: () => {}, warn: (m) => avertissements.push(m) } });
  const recus: MessageJoueur[] = [];
  entree.surMessage((m) => recus.push(m));
  return { transport, entree, recus, avertissements };
}

const ligne = (login: string, texte: string, tags = `user-id=${login.length}${login.charCodeAt(0)};display-name=${login}`) =>
  `@${tags} :${login.toLowerCase()}!${login.toLowerCase()}@x.tmi.twitch.tv PRIVMSG #c :${texte}`;

const E0000 = String.fromCodePoint(0xe0000);
const CGJ = String.fromCodePoint(0x034f);
const NBSP = String.fromCodePoint(0x00a0);
const RLO = String.fromCodePoint(0x202e);
const SOH = String.fromCharCode(1);

describe('nettoyage', () => {
  it('« 1987 » suivi de U+E0000, de U+034F ou d’une espace insécable est lu « 1987 »', () => {
    const { transport, recus } = monter();
    for (const suffixe of [E0000, ` ${E0000}`, CGJ, NBSP]) transport.irc(ligne('alice', `1987${suffixe}`));
    expect(recus.map((m) => m.texte)).toEqual(['1987', '1987', '1987', '1987']);
  });

  it('un texte contenant U+202E ressort sans ce caractère', () => {
    const { transport, recus } = monter();
    transport.irc(ligne('alice', `abc${RLO}def`));
    expect(recus[0]!.texte).toBe('abcdef');
  });

  it('/me !points fonctionne comme !points', () => {
    const { transport, recus } = monter();
    transport.irc(ligne('alice', `${SOH}ACTION !points${SOH}`));
    expect(recus[0]!.texte).toBe('!points');
  });

  it('un message vide après nettoyage ne va nulle part', () => {
    const { transport, recus } = monter();
    transport.irc(ligne('alice', E0000));
    expect(recus).toHaveLength(0);
  });
});

describe('qui parle', () => {
  it('ignore Nightbot et le bot lui-même', () => {
    const { transport, recus } = monter();
    transport.irc(ligne('Nightbot', '!points'));
    transport.irc(ligne('mon_bot', '!points'));
    transport.irc(ligne('StreamElements', '1987'));
    transport.irc(ligne('alice', '1987'));
    expect(recus.map((m) => m.joueur.login)).toEqual(['alice']);
  });

  it('ignore les comptes ajoutés par BOTS_IGNORES', () => {
    const { transport, recus } = monter([...DEFAULT_IGNORED_BOTS, 'autre_bot']);
    transport.irc(ligne('autre_bot', '!points'));
    transport.irc(ligne('Autre_Bot', '!points'));
    transport.irc(ligne('bob', '!points'));
    expect(recus.map((m) => m.joueur.login)).toEqual(['bob']);
  });

  it('identifie le joueur par user-id : deux pseudos, un seul joueur', () => {
    const { transport, recus } = monter();
    transport.irc(ligne('Alice', '1', 'user-id=42;display-name=Alice'));
    transport.irc(ligne('AliceRenommee', '2', 'user-id=42;display-name=AliceRenommee'));
    expect(new Set(recus.map((m) => m.joueur.userId))).toEqual(new Set(['42']));
    expect(recus.at(-1)!.joueur.displayName).toBe('AliceRenommee');
  });

  it('ignore un message sans user-id, et ne prévient qu’une fois', () => {
    const { transport, recus, avertissements } = monter();
    transport.irc(':bob!bob@x PRIVMSG #c :1987');
    transport.irc(':carl!carl@x PRIVMSG #c :1988');
    expect(recus).toHaveLength(0);
    expect(avertissements).toHaveLength(1);
  });

  it('lit modérateur et streamer dans les badges, pas dans le pseudo', () => {
    const { transport, recus } = monter();
    transport.irc(ligne('moderator', '!jeu stop', 'user-id=1;display-name=moderator;badges='));
    transport.irc(ligne('m', '!jeu stop', 'user-id=2;display-name=m;mod=1'));
    transport.irc(ligne('s', '!jeu stop', 'user-id=3;display-name=s;badges=broadcaster/1'));
    expect(recus.map((m) => m.joueur.estModo)).toEqual([false, true, true]);
  });

  it('garde l’identifiant du message, pour CLEARMSG', () => {
    const { transport, recus } = monter();
    transport.irc(ligne('alice', '1987', 'user-id=1;display-name=alice;id=abc-123'));
    expect(recus[0]!.id).toBe('abc-123');
  });
});

describe('retraits', () => {
  it('transmet les retraits tels quels', () => {
    const { transport, entree } = monter();
    const vus: Retrait[] = [];
    entree.surRetrait((r) => vus.push(r));
    transport.retrait({ type: 'message', messageId: 'x' });
    expect(vus).toEqual([{ type: 'message', messageId: 'x' }]);
  });
});
