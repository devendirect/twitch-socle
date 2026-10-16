/**
 * Analyse du protocole IRC de Twitch (copié de `sncf/src/chat/irc.ts`).
 *
 * Isolé du réseau et sans dépendance : c'est la partie qu'on peut réellement
 * tester, et celle qui casse silencieusement quand Twitch ajoute un tag.
 *
 * Différences avec le SNCF : `ChatLine` porte l'identifiant du message (pour
 * `CLEARMSG`) et un `userId` nul quand le tag manque, au lieu de retomber sur
 * le login ; `CLEARMSG` et `CLEARCHAT` sont lus ici (`toRetrait`). Le découpage
 * des messages envoyés est passé dans `sortie.ts`.
 *
 * Une ligne ressemble à :
 *   @badge-info=;color=#FF0000;display-name=Alice;user-id=12345;… :alice!alice@alice.tmi.twitch.tv PRIVMSG #chaine :!train 3 250
 */

import type { ChatLine, Retrait } from '../types.js';

export interface IrcMessage {
  tags: Record<string, string>;
  /** Pseudo extrait du préfixe, en minuscules. */
  nick: string | null;
  command: string;
  params: string[];
  /** Dernier paramètre (le texte du message pour un PRIVMSG). */
  trailing: string | null;
  raw: string;
}

/** Déséchappe les valeurs de tags IRCv3 : `\s` = espace, `\:` = point-virgule. */
function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case 's':
        return ' ';
      case ':':
        return ';';
      case 'r':
        return '\r';
      case 'n':
        return '\n';
      case '\\':
        return '\\';
      default:
        return char;
    }
  });
}

export function parseIrcLine(line: string): IrcMessage | null {
  const raw = line.replace(/[\r\n]+$/, '');
  if (!raw) return null;

  let rest = raw;
  const tags: Record<string, string> = {};

  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    for (const pair of rest.slice(1, end).split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) {
        tags[pair] = '';
      } else {
        tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
      }
    }
    rest = rest.slice(end + 1);
  }

  let nick: string | null = null;
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    const prefix = rest.slice(1, end);
    nick = (prefix.split('!')[0] ?? '').toLowerCase() || null;
    rest = rest.slice(end + 1);
  }

  // Le paramètre final est précédé de « : » et peut contenir des espaces.
  let trailing: string | null = null;
  const trailingAt = rest.indexOf(' :');
  if (rest.startsWith(':')) {
    trailing = rest.slice(1);
    rest = '';
  } else if (trailingAt !== -1) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }

  const parts = rest.split(' ').filter(Boolean);
  const command = (parts.shift() ?? '').toUpperCase();
  if (!command) return null;

  const params = trailing === null ? parts : [...parts, trailing];

  return { tags, nick, command, params, trailing, raw };
}

/**
 * Caractères invisibles à retirer du texte reçu, avant toute analyse.
 *
 * Chatterino et 7TV ajoutent U+E0000 (bloc des étiquettes) quand on renvoie le
 * même message, pour passer l'anti-doublon de Twitch. `trim()` ne l'enlève
 * pas : collé au dernier mot, `!train 3 250` devenait une mise illisible ;
 * séparé par une espace, il ajoutait un argument fantôme. Dans les deux cas, un
 * pari refusé sans explication.
 *
 * Retirés : étiquettes U+E0000–U+E007F, U+034F, U+200B–U+200D, U+2060, U+FEFF
 * et les caractères de contrôle.
 *
 * Aussi les marques de sens d'écriture (U+200E–U+200F, U+202A–U+202E,
 * U+2066–U+2069) : glissées dans un pseudo, elles retournent l'affichage de
 * tout ce qui suit sur la même ligne de l'overlay — un classement, un podium.
 */
const INVISIBLES =
  /[\u{E0000}-\u{E007F}\u034F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\p{Cc}]/gu;

/** Texte d'un message tel qu'on l'analyse : sans invisibles, en NFC. */
export function cleanChatText(text: string): string {
  return text.replace(INVISIBLES, '').normalize('NFC').trim();
}

/**
 * Bots courants des chaînes Twitch, ignorés par défaut : leurs messages
 * (« !train » cité dans une annonce, une commande relayée) ne sont pas des
 * paris. `BOTS_IGNORES` en ajoute d'autres.
 */
export const DEFAULT_IGNORED_BOTS: readonly string[] = [
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'soundalerts',
];

/** Délimiteur CTCP (U+0001), construit par code pour rester lisible. */
const CTCP = String.fromCharCode(1);
const ACTION_PREFIX = `${CTCP}ACTION `;

/**
 * `/me !train 3` arrive en `\x01ACTION !train 3\x01`. Le filtre des invisibles
 * retirait les `\x01` mais laissait « ACTION » devant la commande : le pari
 * était ignoré sans un mot. On déplie le message en texte normal.
 */
function unwrapAction(text: string): string {
  if (!text.startsWith(ACTION_PREFIX)) return text;
  const body = text.slice(ACTION_PREFIX.length);
  return body.endsWith(CTCP) ? body.slice(0, -CTCP.length) : body;
}

/** Extrait un message de chat exploitable, ou `null` si ce n'en est pas un. */
export function toChatLine(message: IrcMessage): ChatLine | null {
  if (message.command !== 'PRIVMSG') return null;
  if (message.trailing === null) return null;

  const channel = (message.params[0] ?? '').replace(/^#/, '');
  const login = message.nick ?? message.tags['login'] ?? '';
  if (!login) return null;

  const badges = message.tags['badges'] ?? '';

  return {
    id: message.tags['id'] || null,
    // Twitch envoie les tags même en lecture anonyme (`justinfan`), `user-id`
    // compris : vérifié à l'essai SNCF du 15/10/2026. Sans lui, pas de joueur :
    // un pseudo change, et deux comptes pourraient se confondre. L'entrée
    // ignore alors le message (`entree.ts`).
    userId: message.tags['user-id'] || null,
    // Le pseudo affiché passe par le même filtre : c'est lui qui s'écrit à
    // l'antenne, dans le classement et sur le podium.
    displayName: cleanChatText(message.tags['display-name'] ?? '') || login,
    login,
    channel,
    text: cleanChatText(unwrapAction(message.trailing)),
    isModerator: message.tags['mod'] === '1' || badges.includes('moderator'),
    isBroadcaster: badges.includes('broadcaster'),
  };
}

/**
 * Ce qu'un modérateur retire du chat, ou `null`.
 *
 *   `CLEARMSG`             un message supprimé (`target-msg-id`)
 *   `CLEARCHAT` + cible    bannissement ou exclusion : `target-user-id`, et
 *                          `ban-duration` distingue l'exclusion du bannissement
 *   `CLEARCHAT` sans cible le chat vidé : ce n'est pas une sanction, rien
 */
export function toRetrait(message: IrcMessage): Retrait | null {
  if (message.command === 'CLEARMSG') {
    const messageId = message.tags['target-msg-id'];
    return messageId ? { type: 'message', messageId } : null;
  }
  if (message.command === 'CLEARCHAT') {
    const login = message.trailing;
    const userId = message.tags['target-user-id'];
    if (!login || !userId) return null;
    const duration = message.tags['ban-duration'];
    return {
      type: 'utilisateur',
      userId,
      login: login.toLowerCase(),
      dureeSecondes: duration ? Number(duration) : null,
    };
  }
  return null;
}
