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

---

## D-012 — La file de transmission vit dans PostgreSQL, pas dans Redis

**Date :** Sprint 4

**Problème.** Une file de tâches se met naturellement dans Redis, et BullMQ était
déjà installé pour cela.

**Décision.** La file de transmission à la DGI est une table PostgreSQL.

**Pourquoi.** Ce ne sont pas des tâches, ce sont des pièces comptables en
attente. Trois conséquences :

- La file doit survivre à une perte de Redis. Une facture qui disparaît d'une
  file est une facture jamais transmise, découverte au contrôle fiscal.
- L'avancement de la file et la mise à jour de la facture doivent se faire dans
  **la même transaction**. Avec deux systèmes, une facture peut être marquée
  certifiée sans que la file l'enregistre, ou l'inverse.
- Une facture entre en file dans la transaction même qui l'enregistre : une
  facture enregistrée part forcément à la DGI, et une entrée de file désigne
  forcément une facture existante.

Redis reste utile pour du cache et des compteurs — pas pour ce qui engage
juridiquement le client.

---

## D-013 — Un rôle dédié, porteur de BYPASSRLS, pour le balayage de la file

**Date :** Sprint 4

**Problème.** Découvert en test, après un diagnostic qui a demandé plusieurs
tentatives : le connecteur balaie la file pour **toutes** les entreprises, donc
sans contexte tenant, et ne remontait rien.

La cause : les tables portent `FORCE ROW LEVEL SECURITY`, qui s'applique y
compris au propriétaire. Une fonction `SECURITY DEFINER` appartenant au
propriétaire des tables ne contourne donc pas les politiques — contrairement à ce
que je supposais en écrivant la migration 003.

**Décision.** Un rôle `fneplus_connecteur`, sans connexion possible (`NOLOGIN`),
porteur de `BYPASSRLS`, propriétaire des seules fonctions de balayage de la file
et destinataire de droits sur cette seule table.

**Pourquoi pas plus simple.** Affaiblir la RLS sur `file_transmission`, ou donner
`BYPASSRLS` au rôle applicatif, aurait ouvert un accès global à des tables
contenant des pièces comptables. Ici la porte est étroite, nommée, et vérifiable
en une requête : ce rôle ne peut pas se connecter et ne possède que cinq
fonctions.

**À retenir.** `FORCE ROW LEVEL SECURITY` + `SECURITY DEFINER` ne suffit pas à
obtenir un contournement. Il faut `BYPASSRLS`, explicitement.

---

## D-014 — Le scellé prouve l'intégrité, pas encore la date

**Date :** Sprint 4

**Problème.** Le cahier des charges demande un archivage horodaté et
infalsifiable. La chaîne d'empreintes prouve qu'aucune facture n'a été modifiée
ni supprimée, mais pas qu'elle existait à une date donnée : rien n'empêcherait de
reconstruire une chaîne entière après coup.

**Décision.** Les scellés sont posés et signés par le serveur (HMAC), et le
champ `horodatage_qualifie` vaut **faux**. L'API et les tests le disent
explicitement.

**Pourquoi ne pas faire semblant.** Un horodatage opposable exige une autorité
tierce (RFC 3161). C'est un contrat à passer, pas une ligne de code. Marquer un
scellé « qualifié » alors qu'il ne l'est pas exposerait le client à voir son
archivage rejeté lors d'un contrôle, en croyant être en règle.

**Ce qui reste à faire avant la production :** contractualiser une autorité
d'horodatage, brancher `jeton_horodatage` sur un vrai jeton RFC 3161, et basculer
le champ. Rien d'autre ne change : la structure est prête.

---

## D-015 — Le simulateur DGI parle le langage de la DGI, pas le nôtre

**Date :** Sprint 4

**Constat.** Le simulateur, écrit au Sprint 0, validait le modèle **interne**
(`hash`, `entrepriseId`). Quand la couche d'anticorruption est arrivée, il a
refusé toutes les factures : elle envoie `empreinte` et `ncc`.

**Décision.** Le simulateur est aligné sur le schéma **sortant**, celui que
produit la couche de traduction.

**Ce que ça apporte.** Le simulateur vérifie désormais la traduction elle-même.
Si quelqu'un modifie le mapping sans mettre à jour ce qui est attendu côté DGI,
les tests d'intégration le signalent — ce qui est précisément le rôle d'une
couche d'anticorruption : rendre visible le contrat avec l'extérieur.

---

## D-016 — Encaissement : deux chemins, deux disponibilités réseau

**Date :** Sprint 5

**Constat.** Le cahier des charges demande d'encaisser en espèces et en mobile
money, mais ces deux moyens n'ont pas la même relation au réseau : l'espèces se
constate immédiatement, en main, sans tiers ; le mobile money suppose d'ouvrir
une demande chez un prestataire externe, ce qui exige le réseau au moment même
de la demande.

**Décision.** Deux chemins séparés plutôt qu'une abstraction commune :

- **Espèces** (`enregistrerPaiementEspeces`) écrit en local et empile une
  commande d'outbox dans la même transaction que la facture, exactement comme
  l'émission elle-même — fonctionne hors ligne, sans exception.
- **Mobile money** (`DEMANDER_PAIEMENT_MOBILE`) appelle l'API directement,
  échoue proprement si le terminal est hors ligne, et ne passe jamais par
  l'outbox : une demande de paiement n'a de sens qu'immédiate.

**Pourquoi pas une seule commande générique.** Une commande « ENCAISSER » unique
aurait dû se comporter différemment selon le moyen choisi, ce qui aurait
déplacé la branche espèces/mobile money dans la couche de synchronisation — le
mauvais endroit pour une décision qui ne dépend que du moyen de paiement.

---

## D-017 — Le webhook de paiement réutilise le rôle `fneplus_connecteur`

**Date :** Sprint 5

**Problème.** Le webhook du prestataire mobile money ne porte aucun contexte
tenant : il ne connaît que sa propre référence de transaction, pas l'entreprise
concernée.

**Décision.** Plutôt que d'inventer un nouveau mécanisme, réutilisation du
rôle `fneplus_connecteur` (porteur de `BYPASSRLS`, introduit en [[D-013]] pour
la file de transmission DGI) et d'une fonction `SECURITY DEFINER`
(`fneplus_paiement_par_reference`) qui lui appartient, pour retrouver le
paiement sans session tenant.

**Pourquoi.** Le problème est identique à celui de la file DGI : un processus
d'arrière-plan doit lire à travers les entreprises sans qu'aucune ne lui soit
jamais donnée en clair. La solution qui a déjà fait ses preuves s'applique sans
modification — une porte étroite, nommée, plutôt qu'un nouvel affaiblissement
de la RLS.

---

## D-018 — Bug trouvé en démonstration : la demande mobile money peut devancer

la synchronisation de la facture

**Date :** Sprint 5

**Problème.** Découvert en testant l'application réellement (« lance l'app »),
pas par les tests automatisés : émettre une facture puis cliquer aussitôt sur
« Orange Money » renvoie _Internal server error_ — _Facture introuvable_. La
facture existe bien, mais seulement dans la base locale du terminal ; elle
n'atteint le serveur que par la synchronisation de fond, qui tourne au plus
toutes les 60 secondes. La demande de paiement mobile money, elle, appelle
l'API immédiatement ([[D-016]]) et ne trouve donc rien côté serveur.

C'est exactement le scénario le plus probable en caisse réelle : le client
paie tout de suite après avoir vu le total.

**Décision.** Avant d'appeler l'API de demande de paiement, le worker force une
synchronisation (`synchroniser(..., { ignorerDelais: true })`). Le réseau est de
toute façon requis pour la suite de l'opération : ce coup de pouce ne coûte rien
et ferme la fenêtre de course.

**À retenir.** Un test automatisé qui crée la facture directement en base ne
peut pas voir ce bug — il suppose la synchronisation déjà faite. Seul un
parcours complet, à la vitesse d'un vrai caissier, l'a révélé.

---

## D-019 — Bug trouvé en démonstration : le rapprochement automatique ne

rapprochait rien

**Date :** Sprint 5

**Problème.** Plus grave que [[D-018]], trouvé juste après l'avoir corrigé : une
fois la demande de paiement acceptée, le webhook du prestataire confirmait bien
le règlement côté serveur (`paiements.statut = REGLEE` en base Postgres), mais
l'écran de caisse continuait d'afficher « reste à devoir » indéfiniment. Le
panneau interroge `ETAT_REGLEMENT` toutes les 4 secondes, mais ce gestionnaire
ne lisait que la base SQLite locale — qu'aucun mécanisme ne mettait à jour, le
webhook ne touchant jamais l'appareil. Contrairement aux clients et produits,
qui ont un delta descendant ([[D-011]] pour le principe), le règlement n'en
avait pas.

**Décision.** `ETAT_REGLEMENT` interroge désormais le serveur
(`GET /api/v1/paiements/factures/:id`, source de vérité pour un règlement qui
peut avoir eu lieu hors de l'appareil) quand une session existe, et répercute le
résultat dans la base locale (`appliquerReglementServeur`). Hors ligne, ou si
l'appel échoue, l'état local reste la meilleure réponse disponible — dégradation
sans blocage, comme partout ailleurs dans l'application.

**Pourquoi ne pas avoir vu ça dans les tests.** Les tests d'intégration API
vérifient que le webhook met bien à jour Postgres — ce qui est vrai et suffisant
de leur point de vue. Aucun test ne rejoue le parcours complet terminal → API →
webhook → terminal, parce que la base locale du terminal n'existe que dans le
navigateur. C'est la démonstration dans un vrai navigateur, pas la suite de
tests, qui a mis ce trou en évidence.

---

## D-020 — L'alerte ARF se déclenche avant l'échéance, pas le jour même

**Date :** Sprint 5

**Constat.** Le cahier des charges est explicite : le commerçant doit être
prévenu **avant** que son attestation n'expire, pas le découvrir le jour où
elle n'est plus valide.

**Décision.** `ArfService.situation()` calcule un statut `BIENTOT_EXPIREE` dès
que l'échéance tombe à 30 jours ou moins, avec un message qui invite à
renouveler — distinct d'`EXPIREE`, dont le message dit explicitement que la
facturation est bloquée. Une révocation manuelle (contrôle fiscal en cours,
etc.) prime sur la date, quelle qu'elle soit.

**Vérifié en démonstration.** Une attestation à 15 jours de l'échéance affiche
bien « Bientôt expirée — 15 jours restants » sur la tuile du tableau de bord,
sans action de l'utilisateur.
