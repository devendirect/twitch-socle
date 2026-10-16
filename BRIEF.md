# Brief — le socle commun des mini-jeux Twitch

> Étape « 0 bis » du programme validé le 15 octobre 2026. À faire **avant** le premier
> nouveau jeu (`../prenoms`). Durée visée : une à deux sessions de Claude Code.

## 1. En une phrase

Un petit paquet TypeScript, `twitch/socle`, qui contient tout ce qu'un mini-jeu de chat
Twitch doit avoir et qui n'a rien à voir avec sa règle : lire et écrire dans le chat en
français et en anglais, compter des points, diffuser l'état vers un overlay OBS, garder
les scores, protéger le serveur et le compte du bot, effacer un joueur sur demande, et
simuler un chat pour développer et filmer sans stream. Chaque nouveau jeu n'écrit plus
que sa règle, ses données et son écran.

## 2. La règle d'or : copier, ne pas déplacer

Le socle est **copié** depuis `../sncf`, jamais déplacé. Le jeu SNCF n'est pas modifié dans
cette étape. Ce qu'il lui manque par rapport à ce socle est listé dans
`../sncf/A-METTRE-A-JOUR.md`, à traiter à part.

> **Mise à jour du 15/10/2026.** Le SNCF a tourné deux fois en direct sur la chaîne, et la
> plupart des protections de ce brief y sont déjà faites et testées (411 tests) : `Host` en
> liste blanche, CSP, `.env` validé par Zod, `/me`, bots ignorés, file d'envoi 20 / 30 s,
> anti-doublon, `NOTICE` de refus, jeton masqué, `CLEARCHAT`, purge `PURGE_MOIS`,
> `!donnees`. La copie part donc de ces versions : il reste surtout à les rendre génériques.

Chaque fichier copié garde ses tests, copiés et adaptés avec lui. Les commentaires qui
expliquent un « pourquoi » (refus définitif du jeton, tri par victoires, filtre CRLF…)
sont gardés : ce sont des bugs déjà payés.

---

## 3. Ce qui va dans le socle

| Module du socle | Origine | Ce qu'il fait / ce qui change |
|---|---|---|
| `src/types.ts` | nouveau | `Logger`, `ChatTransport`, `ChatLine`, `MiniJeu` (section 9) |
| `src/config.ts` | nouveau | lit et **valide le `.env` avec Zod au démarrage** ; message clair et arrêt si une valeur manque ou est invalide (section 11) |
| `src/chat/irc.ts` | copié de `sncf/src/chat/irc.ts` | + messages `/me` (`\x01ACTION …\x01`) dépliés en texte normal, + `CLEARMSG` / `CLEARCHAT` exposés comme événements |
| `src/chat/client.ts` | copié de `sncf/src/chat/client.ts` | `Logger` et `ChatTransport` viennent de `src/types.ts` ; garde les 4 états d'authentification, le `PING`/`PONG`, `RECONNECT`, le repli exponentiel |
| `src/chat/entree.ts` | nouveau | **tout message reçu passe par là** avant d'atteindre un jeu (section 5) |
| `src/chat/sortie.ts` | `splitForChat` de `irc.ts` + file de `client.ts` | **tout message envoyé passe par là** (section 6) |
| `src/commandes.ts` | partie commune de `sncf/src/bets/commands.ts` | analyse des commandes, alias français et anglais, commandes communes, commandes de modération (section 4) |
| `src/i18n/messages.fr.ts`, `messages.en.ts` | nouveau | **tous** les textes du bot ; aucun texte en dur ailleurs (section 4) |
| `src/limites.ts` | nouveau | limite de fréquence générique : par personne, globale, file bornée |
| `src/clock.ts` | copié de `sncf/src/server/clock.ts` | inchangé (`systemClock`, `AcceleratedClock`) |
| `src/vote.ts` | copié de `sncf/src/game/vote.ts` | garde `RankedVote`, `VoteOption`, `VoteResult`, `VoteView` ; retire `TrainCandidate` et `trainOption` |
| `src/scores.ts` | nouveau, inspiré de `sncf/src/bets/ledger.ts` | points (pas de mises) : `award`, victoires, classement **par victoires puis points**, `forget` |
| `src/store.ts` | nouveau, inspiré de `sncf/src/store/store.ts` | `node:sqlite` en WAL ; requêtes **toujours préparées** ; tables `players` et `rounds` ; `backup()` par `VACUUM INTO` ; `close()` avec `wal_checkpoint(TRUNCATE)` ; purge des inactifs (section 8) |
| `src/sse.ts` | copié de `sncf/src/server/sse.ts` | **générique** : `SseHub<V>` reçoit `view(): V` ; dernier état renvoyé à la connexion ; diffusions regroupées |
| `src/server.ts` | parties communes de `sncf/src/server/app.ts` et `main.ts` | Fastify, statiques, `/events`, bannière de démarrage, arrêt propre, **toute la sécurité HTTP** (section 7) |
| `src/simu.ts` + `scripts/simu.ts` | nouveau | simulateur de chat (section 10) |
| `public/vendor/fonts*` | copié de `sncf/public/vendor/` | IBM Plex servi localement, inchangé |
| `public/socle/live.js` | idée de `sncf/public/studio/live.js` | client SSE minimal : `/events`, reconnexion, `render(view)` |
| `public/socle/dom.js` | nouveau | **seule façon d'écrire du texte dans une page** : `texte(el, valeur)` (via `textContent`), `nettoyer(valeur, max)` |
| `public/socle/base.css` | nouveau | page 1920 × 1080, fond transparent, polices locales, pied d'attribution |

**Ce qui reste dans `sncf` pour l'instant** : le registre parimutuel (`ledger.ts`) et
`ChatPredictionSink` (extraits au jeu Vélib, n° 7), la carte IGN (`map.js`, extraite au jeu
n° 3), les photos Wikimedia, le studio.

---

## 4. Commandes : français et anglais

**Toutes les commandes s'acceptent dans les deux langues.** Les alias sont déclarés dans
une seule table (`src/commandes.ts`) ; un jeu y **ajoute** les siens par la même table,
jamais par un `switch` à part.

| Commande | Alias acceptés | Effet |
|---|---|---|
| points | `!points`, `!score`, `!solde`, `!balance` | ses points et ses victoires |
| classement | `!classement`, `!top`, `!leaderboard` | les 5 premiers, sur une ligne |
| effacement | `!oubliemoi`, `!oublie-moi`, `!effacemoi`, `!efface-moi`, `!rgpd`, `!forgetme`, `!forget-me` | efface points, victoires, historique, et la réponse en cours |
| données | `!donnees`, `!données`, `!data`, `!privacy` | une ligne : ce qui est gardé, combien de temps, comment l'effacer |
| aide | `!aide`, `!help`, `!commandes`, `!commands` | les commandes du jeu en cours (texte fourni par le jeu) |

**Commandes de modération** (streamer et modérateurs seulement, lus dans les badges du
message, jamais déduits du pseudo) :

| Commande | Alias | Effet |
|---|---|---|
| démarrer | `!jeu start`, `!game start` | lance une partie avec les réglages par défaut |
| arrêter | `!jeu stop`, `!game stop` | arrête la partie, aucune manche en cours ne donne de points |
| passer | `!jeu skip`, `!game skip`, `!jeu passer` | passe la manche en cours |

Un spectateur sans badge qui tape une commande de modération : **ignoré en silence**.

**Lecture des commandes** (dans cet ordre) :
1. nettoyage de l'entrée (section 5) ;
2. majuscules ignorées : `!Classement`, `!CLASSEMENT` ;
3. accents ignorés sur le **nom** de la commande : `!donnees` = `!données` (jamais sur les
   arguments : « Kévin » et « Kevin » sont deux prénoms différents) ;
4. espaces multiples réduits, espaces de début et de fin retirés.

**Réponses du bot : une seule langue**, choisie par `LANGUE=fr` (défaut) ou `LANGUE=en`.
Tous les textes sont des fonctions de `messages.<langue>.ts`
(`classement(lignes) => string`) ; un test vérifie que les deux fichiers ont exactement les
mêmes clés. Un jeu fournit ses propres fichiers de messages sur le même modèle.

Règles reprises du SNCF : un refus ne répond que s'il est actionnable (« tu as déjà
répondu » non, « commande inconnue » non) ; le classement trie par victoires puis points
pour que `!oubliemoi` ne soit jamais rentable.

---

## 5. Entrée : tout message reçu passe par `src/chat/entree.ts`

| Étape | Pourquoi |
|---|---|
| Retirer les caractères invisibles : U+E0000 et la plage des « tags » Unicode (U+E0000–U+E007F), U+034F, U+200B–U+200D, U+2060, U+FEFF | Chatterino et 7TV ajoutent un caractère invisible en fin de message pour contourner l'anti-doublon de Twitch : sans ce nettoyage, `1987` suivi de ce caractère n'est pas reconnu, sans aucune erreur |
| Retirer les caractères de contrôle et les **caractères de sens d'écriture** (U+202A–U+202E, U+2066–U+2069) | ils permettent d'afficher un texte qui se lit autrement qu'il n'est écrit |
| Normaliser en NFC | « é » composé ou décomposé doit donner la même chaîne |
| Déplier `/me` (`\x01ACTION …\x01`) | `/me !points` doit marcher comme `!points` |
| Ignorer les messages du bot lui-même et des comptes de `BOTS_IGNORES` (défaut : `nightbot,streamelements,streamlabs,moobot,fossabot,wizebot,soundalerts`) | un bot qui répond à un bot boucle, et un bot de chaîne n'est pas un joueur |
| Identifier le joueur par **`user-id`** (tag Twitch), jamais par le pseudo | un pseudo change ; l'identifiant non. Le pseudo affiché (`display-name`) est mis à jour à chaque message. Si `user-id` manque, le message est ignoré pour le jeu et un avertissement est journalisé une fois |
| `CLEARMSG` (message supprimé par un modérateur) | la réponse correspondante est **retirée** de la manche en cours (le socle transmet l'identifiant du message, `id`, au jeu) |
| `CLEARCHAT` avec un utilisateur (ban ou timeout) | toutes ses réponses en cours sont retirées ; il garde ses points passés |
| `CLEARCHAT` sans utilisateur (chat vidé) | rien : ce n'est pas une sanction |

**Vérifié à l'essai du 15/10/2026** : une connexion **anonyme** (`justinfan`) reçoit bien
les tags (`user-id`, `badges`, `id`) après `CAP REQ :twitch.tv/tags twitch.tv/commands`.
La lecture anonyme identifie donc les joueurs et lit les badges comme le bot.

---

## 6. Sortie : tout message envoyé passe par `src/chat/sortie.ts`

| Règle | Pourquoi |
|---|---|
| Retirer `\r`, `\n`, `\0` | en IRC, un retour à la ligne transforme la suite en commande émise par le bot (filtre déjà payé dans le SNCF) |
| **Jamais de texte du chat en début de message** : tout message commence par un texte fixe des fichiers de messages ; en dernier rempart, un message qui commencerait quand même par `/` ou `.` est préfixé de `› ` | sur Twitch, un message qui commence par `/` ou `.` est une **commande** ; si le bot est modérateur, `!prenom /ban quelqu'un` repris tel quel bannirait quelqu'un avec le compte du bot |
| Mentions limitées : un texte du chat repris dans une réponse est tronqué à 40 caractères et nettoyé (section 5) | éviter qu'un spectateur fasse dire n'importe quoi au bot |
| Découpage à 480 caractères, aux espaces | Twitch coupe à 500 |
| **File d'envoi limitée** : au plus 1 message par seconde et **20 par 30 secondes** pour un compte normal (100 par 30 s si le bot est modérateur ou VIP, lu dans `USERSTATE`) ; au-delà, les messages attendent ; file bornée à 20, les plus anciens messages **non essentiels** sont abandonnés | au-delà, Twitch bloque temporairement le compte. Chiffres à revérifier dans la documentation Twitch au moment du développement |
| **Anti-doublon** : deux messages identiques à moins de 30 s → le second reçoit une variante (les fichiers de messages prévoient 2 ou 3 formulations pour les messages fréquents) | Twitch refuse un message identique au précédent dans un court délai (`msg_duplicate`) |
| Lire les `NOTICE` de refus (`msg_ratelimit`, `msg_duplicate`, `msg_banned`, `msg_timedout`…) et les journaliser | sinon le bot se tait sans que personne ne le sache |

Le jeton du bot n'apparaît **jamais** dans un journal : `client.ts` remplace toute
occurrence par `***` avant d'écrire (test dédié).

---

## 7. Sécurité HTTP (dans `src/server.ts`)

1. **Écoute sur `127.0.0.1` par défaut** (repris du SNCF).
2. **Liste blanche de l'en-tête `Host`** sur **toutes** les requêtes, lectures comprises :
   `localhost:<port>`, `127.0.0.1:<port>`, `[::1]:<port>`, plus `HOTES_AUTORISES` si
   défini. Sinon 403. C'est la protection contre le *DNS rebinding* : une page web dont le
   nom pointe vers 127.0.0.1 est « same-origin » pour le navigateur et passe le contrôle
   `Origin` = `Host` du SNCF.
3. **Contrôle d'origine** sur toutes les routes qui modifient quelque chose (repris du
   SNCF) : `Sec-Fetch-Site` doit valoir `same-origin` ou `none`, et `Origin`, s'il est
   présent, doit correspondre à un hôte de la liste blanche.
4. **Pas de `text/plain`** : analyseur retiré, comme dans le SNCF (un formulaire forgé est
   rejeté en 415).
5. **Mot de passe du panneau** (confirmé le 15/10/2026 ; la connexion Twitch le remplacera
   au même endroit quand le panneau passera par le site) : si `HOST` n'est pas `127.0.0.1`, `PANEL_TOKEN` (au moins
   32 caractères) devient **obligatoire** et le serveur refuse de démarrer sans lui. Le
   panneau l'envoie dans un en-tête `Authorization: Bearer …` ; l'overlay (lecture seule)
   n'en a pas besoin.
6. **Validation Zod de chaque corps de requête** ; tout champ inconnu refusé.
7. **En-têtes** : `Content-Security-Policy: default-src 'self'; img-src 'self' data:;
   connect-src 'self'` (aucun script externe), `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`.
8. **Jamais de secret vers le navigateur** : ni jeton, ni identifiant client dans
   `/events`, le panneau ou une page.
9. **Côté pages** : aucun texte venu du chat ou d'une API dans `innerHTML`. Tout passe par
   `dom.js` (`textContent`). Un test analyse `public/**/*.{html,js}` et échoue s'il trouve
   `innerHTML`, `outerHTML`, `insertAdjacentHTML` ou `document.write` hors d'une liste
   blanche commentée.
10. **Longueurs affichées bornées** : pseudo 25 caractères, tout autre texte du chat
    40 caractères, avec « … ».
11. **`.gitignore`** : `.env`, `data/`, `*.db*` ; `.env.example` versionné sans valeur.
12. **Dépendances** : versions exactes dans `package.json`, `npm audit` sans alerte haute
    avant chaque jeu.

---

## 8. Données personnelles et cadre légal

- **Minimum stocké** : `user-id`, login, pseudo affiché, points, victoires, date de dernière
  participation. **Aucun message du chat n'est enregistré**, ni en base ni dans les
  journaux (les journaux écrivent « réponse de <user-id> », pas le texte).
- `!donnees` dit en une ligne : ce qui est gardé, la durée, `!oubliemoi`.
- **Purge automatique** des joueurs sans participation depuis `PURGE_MOIS` mois (défaut
  12), au démarrage du serveur.
- `!oubliemoi` efface en base **et** en mémoire, y compris la réponse en cours (repris du
  SNCF).
- **Les points n'ont aucune valeur** : jamais d'achat, de Bits, d'abonnement qui donne des
  points ou un avantage, ni de récompense réelle. C'est ce qui garde les jeux hors du
  champ des jeux d'argent (règle du SNCF, valable pour tous les jeux).
- Pas de logo Twitch ni de marque tierce dans les pages.

---

## 9. Le contrat d'un jeu

```ts
export interface MiniJeu<V> {
  id: string;                                   // 'prenoms'
  commandes: TableAlias;                        // ses commandes, FR + EN
  messages: { fr: Messages; en: Messages };     // ses textes
  surCommande(cmd: Commande, now: Date): void;  // commandes déjà analysées par le socle
  surRetrait(messageIds: string[], userId?: string): void;  // CLEARMSG / CLEARCHAT
  surModeration(action: 'start' | 'stop' | 'skip', now: Date): void;
  vue(now: Date): V;                            // recalculée à chaque lecture, jamais en cache
  attribution: string;                          // mention de source, affichée en permanence
}
```

Le socle fournit au jeu : `chat.say(cle, parametres)` (passe par `sortie.ts`), `scores`,
`store`, `clock`, `logger`, `limites`, `broadcast()`.

**La vue est recalculée à chaque lecture** (décision 11 du SNCF : un compte à rebours servi
depuis une copie est faux de plusieurs secondes). Le serveur envoie les secondes restantes
selon son horloge.

**Redémarrage en pleine manche** : la manche est **annulée sans points**, et au démarrage le
bot écrit « La manche en cours a été interrompue, aucun point n'a été compté. » Pas de
reprise comme dans le SNCF : inutile pour des manches de 30 s.

---

## 10. Le simulateur de chat (`npm run simu`)

Indispensable pour développer sans stream et pour **filmer les shorts du jeudi** avec une
partie animée.

- Remplace le transport Twitch par un faux transport (même interface `ChatTransport`) :
  aucune connexion à Twitch.
- `--joueurs 25` : 25 spectateurs fictifs aux pseudos inventés (liste fixe dans le socle,
  jamais de vrais pseudos).
- Chaque jeu fournit un **profil de jeu** : comment un faux joueur répond (par exemple
  « une année proche du pic, avec une erreur aléatoire »). Le socle fournit le rythme :
  réponses étalées, quelques retardataires, quelques réponses changées, un peu de
  conversation hors jeu, un `!points`, un `!oubliemoi`.
- `--graine 42` : même graine, même partie (tests et prises de vue reproductibles).
- `--vitesse 2` : tout va deux fois plus vite (horloge accélérée).
- Le panneau et l'overlay fonctionnent exactement comme en direct, avec un bandeau
  « SIMULATION » visible **dans le panneau seulement** (pas dans l'overlay, pour les prises
  de vue).
- Une invite dans le terminal permet de taper des messages comme un spectateur
  (`alice> 1987`), ou comme modérateur (`@mod> !jeu skip`).

---

## 11. Variables d'environnement (`.env.example` de chaque jeu)

| Variable | Défaut | Rôle |
|---|---|---|
| `TWITCH_CHANNEL` | vide | chaîne lue ; vide → simulateur obligatoire |
| `TWITCH_BOT_TOKEN`, `TWITCH_BOT_USERNAME` | vides | bot qui répond ; vides → lecture anonyme, le jeu reste jouable, seules les annonces manquent |
| `LANGUE` | `fr` | langue des réponses du bot (`fr` ou `en`) |
| `BOTS_IGNORES` | liste de la section 5 | comptes ignorés, séparés par des virgules |
| `PORT` | 3001 et suivants | le SNCF garde 3000 |
| `HOST` | `127.0.0.1` | autre valeur → `PANEL_TOKEN` obligatoire |
| `PANEL_TOKEN` | vide | voir section 7 |
| `HOTES_AUTORISES` | vide | hôtes ajoutés à la liste blanche, séparés par des virgules |
| `PURGE_MOIS` | `12` | durée de conservation des joueurs inactifs |

Validées par Zod au démarrage (`src/config.ts`) : une valeur invalide arrête le serveur
avec un message qui dit laquelle et pourquoi.

**Arrêt propre** (SIGINT, SIGTERM) : la manche en cours est annulée sans points, le bot
écrit « Le jeu s'arrête, à bientôt. » (si connecté et authentifié), la base est fermée
avec `close()`, puis le processus s'arrête. Délai maximal 5 s.

---

## 12. Organisation

```
twitch/
├── socle/            ← ce brief
│   ├── package.json  (name: "socle", type: module, Node ≥ 22, versions exactes)
│   ├── src/  public/  scripts/  tests/
│   └── README.md     (comment brancher un jeu, comment lancer le simulateur)
├── sncf/             ← inchangé ; A-METTRE-A-JOUR.md liste ce qui lui manque
└── prenoms/          ← premier jeu, dépend de "socle": "file:../socle"
```

Même pile que le SNCF : TypeScript, `tsx`, Fastify 5, Zod, Vitest, `node:sqlite`. Aucune
étape de compilation : les jeux importent les `.ts` du socle via `tsx`.

---

## 13. Hors sujet

Prédictions Twitch natives, OAuth avec renouvellement, Extension Twitch, studio de
réglages, paris et mises, connexion au chat par EventSub (voir section 15).

**Étape suivante, décidée le 15/10/2026 : faire reposer le SNCF sur le socle**, une fois le
socle fini et `prenoms` lancé. Le SNCF remplace alors ses copies (`irc.ts`, `client.ts`,
`sse.ts`, `clock.ts`, `vote.ts`, sécurité HTTP, `env.ts`) par celles du socle, et gagne ce
qu'il n'a pas : commandes FR/EN complètes (`!aide`, `!score`…), modération depuis le chat,
textes en `messages.fr.ts` / `messages.en.ts`, message à l'arrêt, simulateur. Son registre
parimutuel, son studio et sa carte restent chez lui. Ses 411 tests doivent rester verts.

---

## 14. Tests d'acceptation

**Copiés du SNCF et verts** : `irc`, `client` (dont les 18 cas de connexion), `vote`.

**Commandes**
- Chaque alias de la section 4 mène à la bonne commande ; `!CLASSEMENT`, `!Classement` et
  `  !classement  ` aussi ; `!données` = `!donnees` ; un argument garde ses accents.
- `!jeu stop` d'un spectateur sans badge : ignoré, aucune réponse ; d'un modérateur ou du
  streamer : exécuté.
- `messages.fr.ts` et `messages.en.ts` ont exactement les mêmes clés ; `LANGUE=en` change
  toutes les réponses.

**Entrée**
- `1987` suivi de U+E0000, de U+034F ou d'une espace insécable est lu comme `1987`.
- Un texte contenant U+202E ressort sans ce caractère.
- `/me !points` fonctionne.
- Un message de Nightbot et un message du bot lui-même sont ignorés.
- Deux pseudos différents avec le même `user-id` = un seul joueur ; le pseudo affiché suit
  le dernier.
- `CLEARMSG` sur une réponse la retire ; `CLEARCHAT` d'un utilisateur retire ses réponses
  en cours ; `CLEARCHAT` global ne retire rien.

**Sortie**
- Un message contenant `\r\n` ne peut pas émettre une seconde commande IRC.
- Une réponse qui reprend `/ban alice` venu du chat ne commence jamais par `/` ni par `.`.
- 30 messages demandés en une seconde : jamais plus de 20 envoyés sur 30 s (horloge
  simulée) ; la file ne dépasse pas 20.
- Deux messages identiques à 5 s d'écart : le second est une variante.
- Le jeton du bot n'apparaît dans aucune ligne de journal, même en cas d'erreur de
  connexion.

**HTTP**
- `Host: evil.example` → 403, même sur `GET /events`.
- POST avec `Sec-Fetch-Site: cross-site` ou un `Origin` étranger → 403 ; en `text/plain`
  → 415 ; avec un champ inconnu → 400.
- `HOST=0.0.0.0` sans `PANEL_TOKEN` → le serveur refuse de démarrer ; avec, une requête
  du panneau sans le bon jeton → 401.
- Les en-têtes de la section 7 sont présents.
- Aucune réponse HTTP ne contient le jeton.
- Le test qui cherche `innerHTML` dans `public/` est vert.

**Données**
- `forget` efface aussi les victoires ; le classement trie par victoires puis points ; un
  joueur effacé qui revient repart de zéro.
- La purge supprime un joueur inactif depuis plus de `PURGE_MOIS` mois et garde les autres.
- Une sauvegarde rouverte **sans** son fichier `-wal` contient toutes les données.
- Aucun texte de message n'est écrit en base.

**Ensemble**
- Un jeu factice (`tests/jeu-factice.ts`) branché sur le socle joue une partie complète
  avec le simulateur et une graine fixe ; deux lancements avec la même graine donnent le
  même classement.
- Redémarrage en pleine manche : aucun point compté, message prévu envoyé.
- `npm test`, `npm run typecheck` et `npm audit --audit-level=high` sont verts.

---

## 15. Risque à surveiller : IRC et EventSub

Le socle lit et écrit le chat par **IRC**, comme le SNCF. Twitch pousse désormais vers
**EventSub** (et l'API `Send Chat Message`) pour les bots. IRC fonctionne toujours, mais
toute la connexion au chat doit rester derrière `ChatTransport` : passer à EventSub doit
se faire en écrivant un nouveau transport, sans toucher aux jeux. À revérifier dans la
documentation Twitch au moment du développement (calendrier éventuel de fin d'IRC).

---

## 16. Pièges connus (repris de `../sncf/REPRISE.md`)

- **CRLF** : les fichiers du SNCF sont en `\r\n`. Écrire les fichiers du socle en `\n`, et
  normaliser avant tout remplacement multi-lignes dans un fichier copié.
- **Antislashs** : ne jamais écrire une expression régulière à travers un heredoc ou un
  script intermédiaire ; éditer le fichier directement, puis relire les regex
  (`grep -n "replace(/\|test(/" src/**/*.ts`). Les plages Unicode de la section 5 sont
  particulièrement exposées : écrire `\u{E0000}` et vérifier dans le fichier final.
- **Tests verts par accident** : pour chaque test de protection, vérifier qu'il échoue
  quand la protection est retirée.
- **Git** : ne pas commiter, ajouter, pousser ni fusionner ; l'utilisateur le fait.
