import { z } from 'zod';
import type { ActionModeration, Commande, FabriqueJeu, Joueur, MessageJoueur } from '../src/types.js';

/**
 * Jeu factice : « devine le nombre ». Sert aux tests d'ensemble et au
 * simulateur du socle — c'est aussi l'exemple le plus court d'un jeu branché.
 *
 * Une manche dure 30 s : le chat tape un nombre de 1 à 100 (sans `!`), une
 * réponse par personne, remplaçable. Le plus proche gagne une victoire ; tout
 * le monde marque `100 − 2 × écart` points, au moins 0.
 */

export const DUREE_MANCHE_MS = 30_000;
export const PAUSE_MS = 10_000;

export interface VueFactice {
  phase: 'attente' | 'manche' | 'resultat';
  secondesRestantes: number;
  reponses: number;
  /** Révélé seulement après la manche. */
  secret: number | null;
  gagnant: string | null;
}

interface Reponse {
  joueur: Joueur;
  nombre: number;
  messageId: string | null;
  at: number;
}

export const jeuFactice: FabriqueJeu<VueFactice> = (outils) => {
  let actif = false;
  let phase: VueFactice['phase'] = 'attente';
  let finAt = 0;
  let secret = 0;
  let manche: string | null = null;
  let numero = 0;
  let gagnant: string | null = null;
  const reponses = new Map<string, Reponse>();

  const ouvrir = (now: Date) => {
    numero += 1;
    manche = `factice-${numero}-${now.getTime()}`;
    secret = 1 + Math.floor(outils.aleatoire() * 100);
    reponses.clear();
    gagnant = null;
    phase = 'manche';
    finAt = now.getTime() + DUREE_MANCHE_MS;
    outils.manches.ouvrir(manche);
    outils.chat.dire('manche', { secondes: DUREE_MANCHE_MS / 1000 });
  };

  const annuler = () => {
    if (manche && phase === 'manche') outils.manches.fermer(manche, 'annulee');
    reponses.clear();
    phase = 'attente';
    manche = null;
  };

  const clore = (now: Date) => {
    const liste = [...reponses.values()].sort(
      (a, b) => Math.abs(a.nombre - secret) - Math.abs(b.nombre - secret) || a.at - b.at,
    );
    const premier = liste[0];
    for (const r of liste) {
      outils.scores.award(r.joueur, Math.max(0, 100 - 2 * Math.abs(r.nombre - secret)), { victoire: r === premier });
    }
    if (manche) outils.manches.fermer(manche, 'terminee');
    gagnant = premier?.joueur.displayName ?? null;
    outils.chat.dire(premier ? 'resultat' : 'personne', { nom: gagnant, nombre: premier?.nombre, secret });
    phase = 'resultat';
    finAt = now.getTime() + PAUSE_MS;
    manche = null;
  };

  return {
    id: 'factice',
    attribution: 'Jeu factice du socle — aucune donnée externe',
    commandes: { indice: ['indice', 'hint'] },
    messages: {
      fr: {
        aide: () => 'Tapez un nombre de 1 à 100',
        manche: (p: { secondes: number }) => [`🔢 Nouvelle manche : un nombre de 1 à 100, ${p.secondes} s !`, `🔢 C’est reparti : de 1 à 100, ${p.secondes} s !`],
        resultat: (p: { nom: string; nombre: number; secret: number }) => `🏁 C’était ${p.secret} : @${p.nom} gagne avec ${p.nombre} !`,
        personne: (p: { secret: number }) => `🏁 C’était ${p.secret}, et personne n’a répondu.`,
        indice: (p: { pair: boolean }) => `Indice : le nombre est ${p.pair ? 'pair' : 'impair'}.`,
      },
      en: {
        aide: () => 'Type a number from 1 to 100',
        manche: (p: { secondes: number }) => [`🔢 New round: a number from 1 to 100, ${p.secondes} s!`, `🔢 Here we go again: 1 to 100, ${p.secondes} s!`],
        resultat: (p: { nom: string; nombre: number; secret: number }) => `🏁 It was ${p.secret}: @${p.nom} wins with ${p.nombre}!`,
        personne: (p: { secret: number }) => `🏁 It was ${p.secret}, and nobody answered.`,
        indice: (p: { pair: boolean }) => `Hint: the number is ${p.pair ? 'even' : 'odd'}.`,
      },
    },

    surCommande(commande: Commande) {
      if (commande.nom === 'indice' && phase === 'manche') {
        outils.chat.dire('indice', { pair: secret % 2 === 0 }, { essentiel: false });
      }
    },

    surMessage(message: MessageJoueur, now: Date) {
      if (phase !== 'manche' || !/^\d{1,3}$/.test(message.texte)) return;
      const nombre = Number(message.texte);
      if (nombre < 1 || nombre > 100) return;
      outils.scores.joueur(message.joueur);
      reponses.set(message.joueur.userId, { joueur: message.joueur, nombre, messageId: message.id, at: now.getTime() });
    },

    surRetrait(messageIds: string[], userId?: string) {
      for (const [id, r] of reponses) {
        if (id === userId || (r.messageId && messageIds.includes(r.messageId))) reponses.delete(id);
      }
    },

    surModeration(action: ActionModeration, now: Date) {
      if (action === 'start') {
        actif = true;
        if (phase !== 'manche') ouvrir(now);
      } else if (action === 'stop') {
        actif = false;
        annuler();
      } else {
        annuler();
        if (actif) ouvrir(now);
      }
    },

    tic(now: Date) {
      if (phase === 'manche' && now.getTime() >= finAt) clore(now);
      else if (phase === 'resultat' && now.getTime() >= finAt) {
        phase = 'attente';
        if (actif) ouvrir(now);
      }
    },

    vue(now: Date): VueFactice {
      return {
        phase,
        secondesRestantes: phase === 'attente' ? 0 : Math.max(0, Math.ceil((finAt - now.getTime()) / 1000)),
        reponses: reponses.size,
        secret: phase === 'resultat' ? secret : null,
        gagnant,
      };
    },

    profilSimu: {
      reponse: (vue, aleatoire) => (vue.phase === 'manche' ? String(1 + Math.floor(aleatoire() * 100)) : null),
    },

    // Panneau : le streamer voit le nombre secret et peut le changer en cours de manche.
    panneau: {
      etat: () => ({ phase, secret: phase === 'attente' ? null : secret }),
      schema: z.object({ action: z.literal('secret'), valeur: z.number().int().min(1).max(100) }).strict(),
      executer(commande) {
        if (phase !== 'manche') return { erreur: 'Aucune manche en cours.' };
        secret = (commande as { valeur: number }).valeur;
      },
    },
  };
};
