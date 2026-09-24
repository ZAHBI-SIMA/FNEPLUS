# Journal des décisions techniques

Une entrée par décision qui contraint la suite du développement. Format court :
le problème, le choix, ce qu'il coûte.

---

## D-001 — SQLite s'exécute dans un Web Worker, pas dans le thread principal

**Date :** Sprint 0

**Problème.** Le plan de développement prévoyait SQLite WASM avec le VFS
`opfs-sahpool` dans le thread principal, pour éviter d'imposer les en-têtes
COOP/COEP à tout le site. À l'exécution, l'installation du VFS échoue avec
« Missing required OPFS APIs », et l'application bascule silencieusement en base
mémoire — c'est-à-dire sans aucune persistance hors ligne, ce qui vide le produit
de sa promesse.

**Cause.** `FileSystemFileHandle.createSyncAccessHandle()` n'est pas exposé dans
le thread principal. Mesuré sur le navigateur cible :

| Contexte         | `createSyncAccessHandle` |
| ---------------- | ------------------------ |
| Thread principal | `undefined`              |
| Web Worker       | `function`               |

**Décision.** Toute la base locale vit dans `apps/web/src/workers/base-locale.worker.ts`.
Le worker n'expose pas de SQL mais des opérations métier complètes
(`EMETTRE_FACTURE`, `ETAT`), et l'interface dialogue avec lui par messages.

**Ce que ça apporte.**

- OPFS fonctionne : la persistance est réelle, vérifiée serveur éteint.
- La transaction d'émission reste indivisible côté worker — aucun `await` ne peut
  s'intercaler entre le BEGIN et le COMMIT, donc jamais de numéro consommé sans
  facture enregistrée.
- Le thread principal ne se fige plus pendant une écriture disque.
- Effet de bord mesuré : le bundle de la page d'accueil passe de 10,1 Ko à
  4,35 Ko, le code de la base partant dans un chunk worker chargé à part.

**Ce que ça coûte.**

- Toute opération sur la base devient asynchrone côté interface.
- Un seul onglet peut détenir la base (contrainte du VFS `sahpool`). Un second
  onglet doit recevoir un message explicite — **à traiter au Sprint 1**.

---

## D-002 — Le budget de poids se mesure sur la route, pas sur le dossier de build

**Date :** Sprint 0

**Problème.** La première version du contrôle de poids additionnait tous les
fichiers de `.next/static/chunks`, et annonçait 257 Ko contre un budget de 200 Ko.
Ce chiffre est faux : il compte des bundles qui ne sont jamais chargés ensemble,
et des variantes du même code.

**Décision.** La mesure lit `app-build-manifest.json`, prend les fichiers de la
route `/`, les déduplique et les compresse en gzip. Les polyfills destinés aux
navigateurs anciens sont reportés séparément : ils ne comptent pas dans le budget
nominal, mais ils sont bien téléchargés par les appareils d'entrée de gamme qui
sont notre cible — les ignorer serait se mentir.

**Mesure actuelle :** 104,7 Ko sur 200 Ko (52 % du budget), plus 38,7 Ko de
polyfills.

---

## D-003 — Le simulateur DGI est un outil de test du connecteur, pas une imitation de l'API

**Date :** Sprint 0

**Problème.** L'accès au bac à sable de `fne.dgi.gouv.ci` n'est pas acquis, et le
schéma exact des réponses reste à confirmer. Attendre bloquerait le calendrier du
MVP ; deviner produirait un faux sentiment de conformité.

**Décision.** Le simulateur ne cherche pas la fidélité de schéma. Il sert à
éprouver le **connecteur** : idempotence sur rejeu, file, repli exponentiel,
tolérance à la lenteur et aux coupures. Il expose donc un panneau de contrôle
(`POST /_simulateur/config`) pour injecter latence, taux d'erreur, taux de rejet
et coupure brutale de connexion.

Le mapping vers le schéma réel de la DGI sera isolé dans une couche
d'anticorruption au Sprint 4 : seule cette couche changera le jour où la
spécification officielle sera disponible.

---

## D-004 — L'isolation multi-tenant est portée par PostgreSQL, pas par le code applicatif

**Date :** Sprint 1

**Problème.** Avec un `WHERE entreprise_id = ?` posé à la main dans chaque
requête, une seule omission suffit à exposer les factures d'un client à un autre.
Sur un produit de conformité fiscale, cette fuite se paierait en confiance et en
contentieux, pas en ticket de support.

**Décision.** Row Level Security sur toutes les tables métier, avec `FORCE`, et
un rôle applicatif (`fneplus_app`) qui ne contourne pas les politiques. Chaque
transaction pose `SET LOCAL fneplus.entreprise_id`, lu depuis le jeton et jamais
depuis un paramètre de requête. Sans ce réglage, les politiques ne laissent
passer aucune ligne : un développeur qui oublie le contexte obtient zéro
résultat, jamais les données d'un autre client.

`SET LOCAL` et non `SET` : le réglage meurt avec la transaction. Sur un pool de
connexions, un `SET` persistant laisserait le contexte d'un client attaché à la
connexion recyclée par le suivant — exactement la fuite que la RLS doit empêcher.

**Deux portes étroites assumées.** La connexion doit retrouver un compte à partir
d'un numéro de téléphone, et l'inscription vérifier qu'un NCC est libre — les
deux avant de connaître l'entreprise. Plutôt que d'affaiblir les politiques, deux
fonctions `SECURITY DEFINER` au `search_path` figé ne rendent que le strict
nécessaire, et ne permettent pas d'énumérer les comptes.

**Vérifié par des tests d'intégration contre un vrai PostgreSQL** : une entreprise
ne voit pas les clients d'une autre, ne peut pas allouer de plage sur le terminal
d'une autre, ni créer un terminal sur son point de vente. Une base simulée
n'aurait rien prouvé de tout cela.

---

## D-005 — L'injection de dépendances est explicite

**Date :** Sprint 1

**Problème.** NestJS résout ses dépendances via les métadonnées `design:paramtypes`
émises par TypeScript. Or esbuild — utilisé par `tsx` en développement et par
Vitest pour les tests — ne les produit pas. Résultat : `Nest can't resolve
dependencies`, au démarrage comme dans les tests.

**Décision.** Chaque dépendance est annotée `@Inject(Classe)`, y compris quand le
type suffirait avec `tsc`. L'application ne dépend plus du compilateur utilisé,
tourne à l'identique sous tsx, Vitest et tsc, et les dépendances sont lisibles
sans connaître le mécanisme de métadonnées.

**Coût.** Un peu de verbosité dans les constructeurs. Préféré à l'ajout d'une
chaîne de compilation SWC pour les tests, qui aurait fait diverger le code
exécuté en test de celui exécuté en production.

---

## D-006 — Le stockage local doit être déclaré persistant

**Date :** Sprint 1

**Problème.** Constaté en test : après deux jours, la session et les commandes en
attente d'un terminal avaient disparu. `navigator.storage.persisted()` renvoyait
`false`. Par défaut, le stockage d'une origine est « au mieux » — le navigateur
peut l'effacer sous pression disque ou après inactivité. Pour un produit qui
promet de garder les factures sur l'appareil, c'est la promesse elle-même qui
tombe : une facture émise hors ligne et pas encore transmise disparaîtrait sans
que personne ne s'en aperçoive.

**Décision.**

1. `navigator.storage.persist()` est demandé à l'ouverture de la base.
2. L'état de conservation est exposé dans l'interface, et un avertissement
   explicite invite à installer la PWA si le navigateur a refusé — c'est ce qui
   fait basculer Chrome vers l'octroi automatique.
3. Cet avertissement est affiché **avant** la connexion, et pas seulement après :
   c'est au moment de s'installer sur un appareil qu'il faut savoir que celui-ci
   ne garderait pas les factures.

**Corollaire.** Le repli en base mémoire ne se déclenche plus au premier échec.
Le VFS `sahpool` verrouille ses fichiers, et un onglet qui vient d'être fermé met
un instant à les relâcher ; basculer immédiatement en mémoire faisait perdre la
session pour un chevauchement de quelques centaines de millisecondes. On réessaie
désormais quatre fois, et un verrou tenu par un autre onglet est signalé comme
tel plutôt que confondu avec une absence de support.

---

## D-007 — Le QR est produit hors ligne, et dit qu'il est provisoire

**Date :** Sprint 2

**Problème.** La structure du QR exigée par la DGI n'est toujours pas confirmée
(point bloquant n° 1). Deux scénarios s'excluent : un QR auto-portant que le
terminal peut produire seul, ou un QR contenant un identifiant renvoyé par
l'administration après transmission — auquel cas la promesse « remise du QR au
client sans attendre la connexion » ne tient plus telle quelle.

Attendre bloquait le Sprint 2. Choisir au hasard aurait produit un faux
sentiment de conformité.

**Décision.** Le terminal produit un QR auto-portant, versionné `FNE1`, contenant
NCC, numéro, date, totaux et empreinte d'intégrité tronquée. Tant que la DGI n'a
pas certifié la facture, le QR est **marqué provisoire** et l'interface le dit au
commerçant en toutes lettres, au lieu de laisser croire à une conformité acquise.

Toute la logique tient dans `packages/core/src/qr/contenu.ts` : le jour où la
spécification arrive, c'est ce seul fichier qui change, et le format versionné
permettra de savoir à quelle règle répondait un QR archivé des années plus tôt.

**Choix de format.** Champs positionnels séparés par `|`, pas de JSON. Un QR plus
court, c'est une matrice moins dense, donc un code qui se lit du premier coup sur
un ticket thermique scanné par un téléphone d'entrée de gamme. Un test vérifie
que le contenu reste sous 150 caractères.

---

## D-008 — Le PDF à valeur probante sera produit par le serveur, pas par le terminal

**Date :** Sprint 2

**Problème.** Le cahier des charges attend un archivage légal. La tentation est
de générer le PDF sur le terminal, au moment de la vente.

**Décision.** Le terminal remet un **reçu imprimable** (HTML avec feuille de
style d'impression, calibrée pour 80 mm de ticket thermique). Le **PDF/A
archivable** sera produit et scellé côté serveur au Sprint 4, avec l'horodatage
qualifié et la chaîne d'intégrité.

**Pourquoi.** Un document à valeur probante doit être scellé par une autorité de
confiance. Un terminal dont l'horloge dérive et dont le logiciel peut être
modifié n'en est pas une. Faire produire le PDF légal par le terminal donnerait
un document opposable produit par la partie qu'il est censé engager.

**Bénéfice collatéral.** Une bibliothèque PDF pèse plusieurs centaines de
kilo-octets. L'éviter sur le terminal préserve le budget de poids, qui reste à
56 % après l'ajout de l'écran de vente et de l'encodeur QR.

---

## D-009 — Le moteur hors-ligne se teste hors navigateur

**Date :** Sprint 3

**Problème.** Toute la logique qui porte la promesse du produit — émission,
numérotation, chaînage d'intégrité, outbox, reprise après coupure — ne tournait
que dans un navigateur, sur SQLite WASM et OPFS. La seule façon de la vérifier
était de piloter une page à la main. Impossible d'exiger 500 factures et une
douzaine de scénarios de panne à chaque commit.

**Décision.** Les dépôts dépendent d'une interface `DepotLocal`, pas de
l'implémentation SQLite WASM. Une seconde implémentation, sur `node:sqlite`,
applique **exactement les mêmes migrations** et permet d'exécuter les modules de
production sous Node.

Ce sont donc les vrais modules qui sont testés, pas des doubles qui finiraient
par diverger du code embarqué. Le seul écart avec la production est le moteur
SQLite lui-même.

**Bénéfice immédiat.** Le critère d'acceptation du sprint — 500 factures émises
hors ligne, sans trou, sans doublon, chaîne intacte — s'exécute en moins d'une
seconde et tourne en intégration continue.

**Bénéfice différé.** Un empaquetage Capacitor, prévu en V2 pour le canal USSD,
utilisera SQLite natif. Seule l'implémentation changera.

---

## D-010 — La date d'émission vient de l'horloge logique, pas de l'horloge système

**Date :** Sprint 3

**Problème.** Découvert en écrivant les tests d'horloge déréglée : avec
`Date.now()`, un terminal dont l'horloge est revenue à une date de fabrication ne
trouve plus aucun référentiel fiscal applicable et **refuse toute vente**. Sur un
téléphone d'entrée de gamme, retirer la batterie suffit à produire cette
situation.

Un commerçant bloqué par une pile déchargée, c'est un incident support et une
journée de chiffre d'affaires perdue.

**Décision.** La date d'émission est prise sur l'horloge hybride, qui porte la
dérive recalée sur l'heure serveur à chaque synchronisation. Un test vérifie
qu'un terminal dont l'horloge système est en 2020 émet malgré tout une facture
correctement datée et correctement taxée.

**Ce que ça ne change pas.** La numérotation n'a jamais dépendu de l'horloge :
elle vient de la réserve allouée par le serveur. Une horloge fausse ne pouvait
donc pas créer de trou ni de doublon — un test le fige explicitement.

---

## D-011 — Un incident, une seule entrée dans « à vérifier »

**Date :** Sprint 3

**Problème.** Repéré en testant l'écran dans le navigateur : une facture refusée
définitivement apparaissait **deux fois** — une fois comme facture à corriger,
une fois comme commande d'envoi en échec. Le compteur annonçait « 2 éléments »
pour un seul incident, et les deux cartes donnaient des consignes
contradictoires : « réessayez » d'un côté, « contactez votre comptable » de
l'autre.

**Décision.** Une commande `CREER_FACTURE` en échec dont la facture est déjà
signalée n'est plus listée séparément. On garde l'entrée « facture », la seule
qui parle au commerçant. Les commandes d'un autre type gardent leur entrée
propre.

**Principe retenu pour la suite.** Un incident produit une entrée, avec une
action. Un compteur qui surévalue les problèmes finit par ne plus être regardé,
ce qui est exactement ce que cet écran doit empêcher.
