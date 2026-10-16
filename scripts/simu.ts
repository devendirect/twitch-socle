/**
 * `npm run simu` du socle : le jeu factice (« devine le nombre ») avec de faux
 * spectateurs. Chaque jeu a son propre `scripts/simu.ts`, sur ce modèle.
 *
 *   npm run simu -- --joueurs 25 --graine 42 --vitesse 2
 */
import { lancerSimu } from '../src/simu.js';
import { jeuFactice } from '../tests/jeu-factice.js';

await lancerSimu(jeuFactice);
