/**
 * Copié de `sncf/tests/irc.test.ts` et adapté : découpage et pseudos viennent
 * de `sortie.ts`, les commandes de `commandes.ts`.
 */

import { describe, expect, it } from 'vitest';
import { parseIrcLine, toChatLine } from '../src/chat/irc.js';
import { pseudo as displayPseudo, splitForChat } from '../src/chat/sortie.js';
import { COMMANDES_SOCLE, analyser, indexer } from '../src/commandes.js';

const TAGGED =
  '@badge-info=subscriber/12;badges=broadcaster/1,subscriber/12;color=#FF0000;' +
  'display-name=AliceStream;emotes=;first-msg=0;id=abc-def;mod=0;room-id=999;' +
  'subscriber=1;tmi-sent-ts=1789900000000;turbo=0;user-id=12345;user-type= ' +
  ':alicestream!alicestream@alicestream.tmi.twitch.tv PRIVMSG #machaine :!train 3 250';

describe('analyse des lignes IRC', () => {
  it('lit tags, préfixe, commande et texte', () => {
    const message = parseIrcLine(TAGGED)!;

    expect(message.command).toBe('PRIVMSG');
    expect(message.nick).toBe('alicestream');
    expect(message.params[0]).toBe('#machaine');
    expect(message.trailing).toBe('!train 3 250');
    expect(message.tags['user-id']).toBe('12345');
    expect(message.tags['display-name']).toBe('AliceStream');
  });

  it('déséchappe les valeurs de tags', () => {
    // `\s` encode l'espace : un pseudo affiché peut en contenir.
    const message = parseIrcLine(
      '@display-name=Alice\\sdu\\sChat;user-id=1 :a!a@a PRIVMSG #c :salut',
    )!;
    expect(message.tags['display-name']).toBe('Alice du Chat');
  });

  it('garde les deux-points du texte', () => {
    const message = parseIrcLine(':a!a@a PRIVMSG #c :regarde : c\'est parti !')!;
    expect(message.trailing).toBe("regarde : c'est parti !");
  });

  it('lit un PING sans préfixe', () => {
    const message = parseIrcLine('PING :tmi.twitch.tv')!;
    expect(message.command).toBe('PING');
    expect(message.trailing).toBe('tmi.twitch.tv');
  });

  it('ignore les lignes vides', () => {
    expect(parseIrcLine('')).toBeNull();
    expect(parseIrcLine('\r\n')).toBeNull();
  });
});

describe('extraction d\u2019un message de chat', () => {
  it('construit une ligne exploitable', () => {
    const line = toChatLine(parseIrcLine(TAGGED)!)!;

    expect(line).toMatchObject({
      userId: '12345',
      displayName: 'AliceStream',
      login: 'alicestream',
      channel: 'machaine',
      text: '!train 3 250',
      isBroadcaster: true,
      isModerator: false,
    });
  });

  /**
   * Le SNCF retombait sur le login quand `user-id` manquait. Le socle ne le
   * fait plus : sans identifiant stable, pas de joueur (l'entrée ignore le
   * message). La ligne reste lisible pour le reste.
   */
  it('sans tags : pas d’identifiant, mais une ligne lisible', () => {
    const line = toChatLine(parseIrcLine(':bob!bob@bob.tmi.twitch.tv PRIVMSG #c :!train 2')!)!;

    expect(line.userId).toBeNull();
    expect(line.id).toBeNull();
    expect(line.displayName).toBe('bob');
    expect(line.text).toBe('!train 2');
  });

  it('reconnaît un modérateur', () => {
    const line = toChatLine(
      parseIrcLine('@mod=1;user-id=7 :m!m@m PRIVMSG #c :!train 1')!,
    )!;
    expect(line.isModerator).toBe(true);
  });

  it('écarte ce qui n\u2019est pas un message de chat', () => {
    expect(toChatLine(parseIrcLine('PING :tmi.twitch.tv')!)).toBeNull();
    expect(toChatLine(parseIrcLine(':tmi.twitch.tv 001 bot :Welcome')!)).toBeNull();
  });
});

describe('découpe des messages sortants', () => {
  it('laisse un message court intact', () => {
    expect(splitForChat('🏁 Résultat : 15 à 30 min !')).toEqual([
      '🏁 Résultat : 15 à 30 min !',
    ]);
  });

  it('découpe aux espaces et reste sous la limite', () => {
    const podium = Array.from({ length: 60 }, (_, i) => `🥇 Parieur${i} +1234`).join(' ');
    const chunks = splitForChat(podium, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect([...chunk].length).toBeLessThanOrEqual(100);
    }
    // Recoller les morceaux doit rendre le message d'origine, à l'identique :
    // c'est ce qui garantit qu'aucun mot n'a été coupé ni perdu.
    expect(chunks.join(' ')).toBe(podium);
  });

  it('préserve un mot plus long que la limite plutôt que de le couper', () => {
    // Un pseudo à rallonge vaut mieux entier, quitte à ce que Twitch tronque.
    const word = 'A'.repeat(150);
    expect(splitForChat(`début ${word}`, 100)).toEqual(['début', word]);
  });

  it('compte en caractères, pas en octets', () => {
    // Les émojis et accents ne doivent pas provoquer de découpe prématurée.
    const message = '🚆'.repeat(50);
    expect(splitForChat(message, 100)).toEqual([message]);
  });
});

describe('caractères invisibles du chat', () => {
  // Une commande de jeu quelconque, déclarée comme le ferait un jeu.
  const INDEX = indexer(COMMANDES_SOCLE, { train: ['train'] });
  const pari = (texte: string) => analyser(texte, INDEX);
  const ligne = (texte: string) =>
    toChatLine(parseIrcLine(`@user-id=7 :bob!bob@bob.tmi.twitch.tv PRIVMSG #c :${texte}`)!)!;

  it('retire le U+E0000 que Chatterino ajoute après une espace', () => {
    // Forme envoyée par Chatterino / 7TV pour contourner l'anti-doublon.
    expect(ligne('!train 3 250 \u{E0000}').text).toBe('!train 3 250');
    expect(pari(ligne('!train 3 250 \u{E0000}').text)).toEqual(pari('!train 3 250'));
  });

  it('lit bien le pari de référence', () => {
    expect(pari('!train 3 250')).toEqual({ nom: 'train', args: ['3', '250'] });
  });

  it('retire le U+E0000 collé au dernier mot', () => {
    expect(ligne('!train 3 250\u{E0000}').text).toBe('!train 3 250');
    expect(pari(ligne('!train 3 250\u{E0000}').text)).toEqual(pari('!train 3 250'));
  });

  it('retire les autres invisibles et les caractères de contrôle', () => {
    expect(ligne('\uFEFF!vote\u200B 2\u2060\u034F\u200D\u0007').text).toBe('!vote 2');
    expect(ligne('\u0001ACTION salut\u0001').text).toBe('salut'); // /me déplié (point 10)
  });

  it('normalise en NFC', () => {
    // « é » décomposé (e + accent combinant) devient le caractère unique.
    expect(ligne('!gare Gare de l\u2019Est Saint-E\u0301milion').text).toBe('!gare Gare de l\u2019Est Saint-\u00C9milion');
  });

  it('garde les emojis et les accents', () => {
    expect(ligne('bravo 🚄 à toi').text).toBe('bravo 🚄 à toi');
  });
});

describe('commandes Twitch en tête de message', () => {
  it('neutralise « / » et « . » en début de message', () => {
    expect(splitForChat('/ban quelqu’un')).toEqual(['› /ban quelqu’un']);
    expect(splitForChat('.timeout quelqu’un 600')).toEqual(['› .timeout quelqu’un 600']);
    expect(splitForChat('   /ban quelqu’un')).toEqual(['› /ban quelqu’un']);
  });

  it('neutralise aussi un morceau découpé qui commencerait ainsi', () => {
    const chunks = splitForChat(`${'a'.repeat(10)} /ban x`, 12);
    expect(chunks).toEqual(['a'.repeat(10), '› /ban x']);
  });

  it('laisse intact un message ordinaire', () => {
    expect(splitForChat('🚆 Paris ouverts. 1/2/3')).toEqual(['🚆 Paris ouverts. 1/2/3']);
  });
});

describe('sens d’écriture et longueur des pseudos', () => {
  // Construits par code : un caractère invisible écrit tel quel dans un test
  // est illisible à la relecture.
  const RLO = String.fromCodePoint(0x202e);
  const LRI = String.fromCodePoint(0x2066);
  const PDI = String.fromCodePoint(0x2069);
  const RLM = String.fromCodePoint(0x200f);

  it('retire les marques de sens d’écriture du texte', () => {
    const line = toChatLine(parseIrcLine(`:bob!bob@bob.tmi.twitch.tv PRIVMSG #c :${RLO}!train 2${RLM}`)!)!;
    expect(line.text).toBe('!train 2');
  });

  it('les retire aussi du pseudo affiché', () => {
    const line = toChatLine(
      parseIrcLine(`@display-name=${LRI}Alice${RLO}${PDI};user-id=1 :alice!alice@alice PRIVMSG #c :salut`)!,
    )!;
    expect(line.displayName).toBe('Alice');
  });

  it('retombe sur le login si le pseudo n’était fait que d’invisibles', () => {
    const line = toChatLine(parseIrcLine(`@display-name=${RLO};user-id=1 :alice!alice@alice PRIVMSG #c :salut`)!)!;
    expect(line.displayName).toBe('alice');
  });

  it('tronque un pseudo trop long à 25 caractères', () => {
    expect(displayPseudo('a'.repeat(25))).toBe('a'.repeat(25));
    expect(displayPseudo('a'.repeat(40))).toBe(`${'a'.repeat(24)}…`);
    expect([...displayPseudo('🚄'.repeat(30))]).toHaveLength(25);
  });
});

describe('messages /me', () => {
  // Délimiteur CTCP construit par code : invisible s'il était écrit tel quel.
  const SOH = String.fromCharCode(1);
  const me = (text: string) =>
    toChatLine(parseIrcLine(`@user-id=1 :alice!alice@alice.tmi.twitch.tv PRIVMSG #c :${text}`)!)!;

  it('déplie /me en texte normal', () => {
    expect(me(`${SOH}ACTION !train 3 250${SOH}`).text).toBe('!train 3 250');
  });

  it('tolère un délimiteur final absent', () => {
    expect(me(`${SOH}ACTION !solde`).text).toBe('!solde');
  });

  it('ne touche pas un message ordinaire qui commence par ACTION', () => {
    expect(me('ACTION !train 3').text).toBe('ACTION !train 3');
  });
});
