/** Ce qu'un jeu importe du socle : `import { lancer, type FabriqueJeu } from 'socle';` */

export * from './types.js';
export { lancer, demarrerJeu, type DemarrageOptions, type Socle, type VueDiffusee } from './demarrer.js';
export { lancerSimu, TransportSimule, Simulateur, mulberry32 } from './simu.js';
export { citer, pseudo } from './chat/sortie.js';
export { RankedVote, type VoteOption, type VoteResult, type VoteView } from './vote.js';
export { AcceleratedClock, systemClock, type Clock } from './clock.js';
export { LimiteFrequence } from './limites.js';
export { Scores } from './scores.js';
export { Store, type Player } from './store.js';
export { chercherHtmlBrut } from './verif.js';
/** Zod du socle, pour le schéma du panneau d'un jeu (`PanneauJeu`) : une seule copie. */
export { z } from 'zod';
