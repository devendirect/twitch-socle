# Socle des mini-jeux Twitch

Ce qu'un mini-jeu de chat Twitch doit avoir et qui n'a rien à voir avec sa règle :
lire et écrire dans le chat (français et anglais), compter des points, diffuser l'état
vers un overlay OBS, garder les scores, protéger le serveur et le compte du bot, effacer
un joueur sur demande, et simuler un chat pour développer et filmer sans stream.

Le pourquoi de chaque choix est dans [`BRIEF.md`](BRIEF.md). Le code vient en grande
partie du jeu SNCF (`../sncf`), copié et rendu générique ; le SNCF n'a pas été modifié.

```
npm install        # npm 8 : voir .npmrc (legacy-peer-deps)
npm test           # 173 tests
npm run typecheck
npm run audit      # avant chaque direct : aucune alerte haute en production
npm run simu       # le jeu factice avec 25 faux spectateurs
```

## Brancher un jeu

Chaque jeu est un dépôt à part, qui dépend du socle à une version fixe :
`"socle": "github:devendirect/twitch-socle#v0.1.0"`. Celui qui clone un jeu n'a que lui à cloner :
`npm install` télécharge le socle. Le jeu n'écrit que sa règle, ses textes et son écran.

Pas de compilation : `tsx` lit les `.ts` du socle même installé dans `node_modules`, et
Vitest aussi (vérifié le 16/10/2026 avec `prenoms` installé depuis une archive
`npm pack`, l'équivalent d'une installation depuis GitHub). `files` dans `package.json`
limite ce qu'un jeu reçoit : `src`, `public`, `.env.example`, ce README.

**Publier une version** : commit, puis tag `vX.Y.Z` poussé ; dans chaque jeu, changer le
tag dans `package.json` et relancer `npm install`.

**Modifier le socle et un jeu ensemble** : les deux dépôts côte à côte, puis dans le jeu
`npm link ../socle` (le jeu utilise le socle local) ; `npm install` revient à la version
du `package.json`. Les tests d'un jeu lisent `/socle/dom.js` dans `node_modules/socle` :
ils marchent dans les deux cas.

```ts
// src/main.ts du jeu
import { lancer, type FabriqueJeu } from 'socle';

const monJeu: FabriqueJeu<MaVue> = (outils) => ({
  id: 'prenoms',
  attribution: 'Insee, fichier des prénoms — Licence Ouverte 2.0',
  commandes: { prenom: ['prenom', 'name'] },        // ajoutées à celles du socle
  messages: { fr: { aide: () => 'Devinez l’année : tapez 1987', /* … */ }, en: { /* mêmes clés */ } },
  surCommande(commande, now) { /* !prenom Léa */ },
  surMessage(message, now) { /* « 1987 » sans ! */ },
  surRetrait(messageIds, userId) { /* retirer des réponses en cours */ },
  surModeration(action, now) { /* 'start' | 'stop' | 'skip' */ },
  tic(now) { /* chaque seconde : fermer la manche à l'heure */ },
  vue: (now) => ({ /* recalculée à chaque lecture */ }),
  profilSimu: { reponse: (vue, aleatoire) => String(1950 + Math.floor(aleatoire() * 70)) },
});

await lancer(monJeu, { dossierPublic: 'public' });
```

Le jeu factice [`tests/jeu-factice.ts`](tests/jeu-factice.ts) (« devine le nombre ») est
l'exemple complet le plus court.

**Ce que le socle fournit au jeu** (`outils`) :

| Outil | Rôle |
|---|---|
| `chat.dire(cle, params, { essentiel })` | dit un message du jeu (sinon du socle) dans la langue `LANGUE` ; passe par la sortie |
| `scores` | `joueur()`, `award(joueur, points, { victoire })`, `classement()`, `forget()` ; écrit en base aussitôt |
| `manches.ouvrir(id)` / `fermer(id, statut)` | suivi en base : une manche restée ouverte au redémarrage est annulée sans points, et le chat prévenu |
| `limites.creer({ max, fenetreMs })` | limite de fréquence par clé |
| `clock`, `aleatoire` | horloge et tirage injectés : accélérés et reproductibles sous le simulateur |
| `diffuser()` | rediffuse la vue aux overlays (appels regroupés) |
| `store`, `logger` | base SQLite, journal |

**Ce que le socle fait seul** : les commandes `!points`, `!classement`, `!oubliemoi`,
`!donnees`, `!aide` et leurs alias anglais ; `!jeu start|stop|skip` pour le streamer et
les modérateurs (lus dans les badges, un spectateur est ignoré en silence) ; `/events`
pour l'overlay ; `/api/etat` et `POST /api/moderation` pour le panneau ; l'arrêt propre
(manche annulée, « Le jeu s'arrête, à bientôt. », 5 s au plus).

**Panneau propre au jeu** (facultatif) : `panneau: { etat, schema, executer }` dans le jeu
ouvre `GET /api/jeu` (état privé pour le streamer, jamais diffusé à l'overlay) et
`POST /api/jeu` (corps validé par le schéma Zod, `.strict()` ; `{ erreur }` → 409), avec
les mêmes verrous que tout `/api/*`. Le jeu prend Zod du socle :
`import { z } from 'socle'`. Exemple : `tests/jeu-factice.ts`.

**Textes** : chaque message est une fonction de `messages.fr` / `messages.en`, qui
renvoie un texte ou plusieurs formulations (pour l'anti-doublon de Twitch). Un message
ne commence jamais par une donnée du chat ; pour citer un spectateur, `pseudo(nom)` et
`citer(texte)` nettoient et tronquent (25 et 40 caractères). Les deux langues doivent
avoir les mêmes clés : faites-le vérifier par un test, comme `tests/commandes.test.ts`.

**Pages** : `/socle/dom.js` (`texte`, `element`, `remplacer`, `nettoyer`) est la seule
façon d'écrire du texte ; `/socle/live.js` branche l'overlay sur `/events` ;
`/socle/base.css` pose la page 1920 × 1080 transparente et les polices locales. Dans les
tests du jeu, ajoutez :

```ts
import { chercherHtmlBrut } from 'socle';
expect(chercherHtmlBrut('public')).toEqual([]);
```

**Bandeau « SIMULATION »** : `/api/etat` renvoie `simulation: true` sous le simulateur.
Le panneau du jeu l'affiche ; l'overlay, jamais (prises de vue).

## Simulateur

```
npm run simu -- --joueurs 25 --graine 42 --vitesse 2
```

Aucune connexion à Twitch, aucune écriture dans la vraie base (`:memory:`). Les faux
spectateurs (pseudos inventés, liste fixe) passent par le même chemin que les vrais :
réponses étalées, retardataires, réponses changées, bavardage, `!points`, `!oubliemoi`.
Même graine, même partie. Dans le terminal :

```
alice> 1987          alice écrit « 1987 »
@mod> !jeu skip      un modérateur écrit « !jeu skip »
!jeu start           le streamer écrit
```

Chaque jeu a son `scripts/simu.ts` : `await lancerSimu(monJeu, { dossierPublic: 'public' })`.

## Configuration

Voir [`.env.example`](.env.example). Tout est validé au démarrage : une valeur invalide
arrête le serveur avec la variable en cause. Points à retenir :

- `HOST` autre que `127.0.0.1` / `localhost` → `PANEL_TOKEN` (32 caractères au moins)
  **obligatoire**, envoyé par le panneau en `Authorization: Bearer …`. Il sera remplacé
  au même endroit par une connexion Twitch quand le panneau passera par le site.
- Lecture **anonyme** (sans jeton) : les tags Twitch arrivent quand même, `user-id` et
  badges compris (vérifié sur la chaîne le 15/10/2026, essai SNCF). Le jeu est jouable,
  seules les annonces manquent.
- Un message sans `user-id` est ignoré pour le jeu (avertissement une seule fois).

## Sécurité, en bref

`Host` en liste blanche sur toutes les requêtes (DNS rebinding) ; `Sec-Fetch-Site` et
`Origin` sur tout ce qui modifie ; pas de `text/plain` (415) ; corps validés par Zod,
champ inconnu refusé (400) ; CSP sans script externe ni `unsafe-inline` ; `nosniff`,
`no-referrer` ; jeton du bot masqué dans les journaux ; aucun secret vers le navigateur ;
aucun message du chat en base ni dans les journaux.

Chaque protection a été retirée une à une pour vérifier qu'un test échoue alors
(30 protections, 16/10/2026).

## Twitch : chiffres vérifiés

[Documentation chat](https://dev.twitch.tv/docs/chat/), relue le 16/10/2026 :

- 20 messages par 30 s et 1 par seconde pour un compte ordinaire ; 100 par 30 s pour le
  diffuseur, un modérateur ou un VIP. La sortie applique ces limites (`USERSTATE`).
- IRC n'est ni déprécié ni daté pour fermeture ; Twitch recommande EventSub et l'API pour
  les nouveaux bots. Toute la connexion est derrière `ChatTransport` : passer à EventSub
  sera un nouveau transport, sans toucher aux jeux.

## Pièges

- **Fins de ligne** : le socle est en LF, le SNCF en CRLF.
- **Antislashs** : ne jamais écrire une expression régulière à travers un script
  intermédiaire ; relire les regex dans le fichier final.
- **npm 8** bute sur les dépendances « pair » de vitest 5 : `.npmrc` contient
  `legacy-peer-deps=true`, et `vite` est déclaré explicitement.
- **Git** : ne pas commiter, ajouter, pousser ni fusionner ; l'utilisateur le fait.
