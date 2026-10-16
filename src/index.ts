/** Ce qu'un jeu importe du socle : `import { lancer, type FabriqueJeu } from 'socle';` */

export * from './types.js';
export { lancer, demarrerJeu, type DemarrageOptions, type Socle, type VueDiffusee } from './demarrer.js';
export {
  lancerSimu,
  lireArguments,
  TransportSimule,
  Simulateur,
  mulberry32,
  userIdDe,
  PSEUDOS_FICTIFS,
  type SimulateurOptions,
} from './simu.js';
export { citer, pseudo } from './chat/sortie.js';
export { RankedVote, type VoteOption, type VoteReason, type VoteResult, type VoteView } from './vote.js';
export { AcceleratedClock, systemClock, type Clock } from './clock.js';
export { LimiteFrequence } from './limites.js';
export { Scores } from './scores.js';
export { Store, type Player } from './store.js';
export { chercherHtmlBrut } from './verif.js';
/** Zod du socle, pour le schéma du panneau d'un jeu (`PanneauJeu`) : une seule copie. */
export { z } from 'zod';

/*
 * Briques, pour un jeu qui garde son propre serveur au lieu de passer par
 * `lancer` (le SNCF : ses routes, son registre de mises, son studio). Ce sont
 * celles que `lancer` assemble : un jeu qui s'en sert garde les mêmes
 * protections, à condition de tout faire passer par elles.
 */
export { TwitchChatClient, maskedLogger, type ChatClientOptions, type ChatRefusal } from './chat/client.js';
export { Entree, type EntreeOptions } from './chat/entree.js';
export { Sortie, splitForChat, type SortieOptions } from './chat/sortie.js';
export { cleanChatText, parseIrcLine, toChatLine, toRetrait, DEFAULT_IGNORED_BOTS, type IrcMessage } from './chat/irc.js';
export { SseHub } from './sse.js';
export {
  creerServeur,
  isAllowedHost,
  securityHeaders,
  inlineScriptHashes,
  valider,
  type CspSupplement,
  type DossierPublic,
  type ServeurOptions,
} from './server.js';
export {
  lireConfig,
  champs,
  ConfigError,
  ecouteLocale,
  PANEL_TOKEN_MIN,
  type Config,
  type LireConfigOptions,
} from './config.js';
export { COMMANDES_SOCLE, analyser, indexer, actionModeration, plier, type CommandeLue } from './commandes.js';
export { messagesFr as messagesSocleFr, type LigneClassement } from './i18n/messages.fr.js';
export { messagesEn as messagesSocleEn } from './i18n/messages.en.js';
