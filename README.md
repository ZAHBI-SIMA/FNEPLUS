# FNE+

Plateforme de facturation électronique conforme FNE pour les TPE/PME de Côte d'Ivoire.

**Le produit se distingue par une seule chose : il fonctionne sans réseau.** Le socle
réglementaire est déjà occupé par plusieurs acteurs ; le hors-ligne ne l'est pas. Toute
l'architecture découle de ce choix.

- Cahier des charges : `input/Cahier-des-charges-FNE-plus.pdf` (document interne, non publié)
- Plan de développement : [`docs/PLAN-DEVELOPPEMENT.md`](docs/PLAN-DEVELOPPEMENT.md)

---

## État d'avancement

| Sprint | Contenu                                                         | Statut                            |
| ------ | --------------------------------------------------------------- | --------------------------------- |
| 0      | Socle : monorepo, design system, PWA hors ligne, simulateur DGI | ✅ terminé                        |
| 1      | Identité, auth OTP, référentiels clients/produits, multi-tenant | ✅ terminé                        |
| 2      | Écran de vente, catalogue articles, QR et reçu imprimable       | ✅ terminé                        |
| 3      | Hors-ligne durci : tests adverses, écran « à vérifier »         | ✅ terminé                        |
| 4      | Connecteur DGI, file de transmission, archivage et export       | ✅ terminé                        |
| 5      | Mobile money, suivi ARF, tableau de bord                        | ✅ terminé                        |
| 6      | Durcissement, pilote terrain à Abidjan                          | 🟡 outillage prêt, pilote à mener |

**V2 — élargissement des comptes** (multi-boutiques ✅, avoirs et rectificatives ✅ · marque blanche et IA à venir)
**V2 — élargissement des canaux** (USSD/SMS, WhatsApp Business, OCR — à venir, chacun dépend d'un accès tiers non acquis)

---

## Démarrage

Prérequis : Node 22+, pnpm 12+, Docker (pour PostgreSQL et Redis, à partir du Sprint 1).

```bash
pnpm install
pnpm infra:up                          # PostgreSQL + Redis
pnpm --filter @fneplus/api migrer      # schéma et politiques RLS
pnpm --filter @fneplus/api dev         # API sur le port 4001
pnpm --filter @fneplus/web dev         # PWA sur le port 3100
```

L'application est servie sur <http://localhost:3100>, l'API sur
<http://localhost:4001>.

En développement, `SMS_FOURNISSEUR=console` : les codes de connexion sont écrits
dans les logs de l'API au lieu d'être envoyés par SMS. La configuration refuse de
démarrer en production dans ce mode.

Autres commandes utiles :

```bash
pnpm test                              # tests de tous les packages
pnpm build                             # construction complète
pnpm --filter @fneplus/web analyse:poids   # budget de poids du premier chargement
pnpm --filter @fneplus/dgi-sim dev         # simulateur DGI sur le port 4010
pnpm --filter @fneplus/momo-sim dev        # simulateur mobile money sur le port 4020
pnpm infra:up                          # PostgreSQL + Redis

./infra/sauvegarde.sh                  # sauvegarde de la base (pg_dump)
./infra/tester-restauration.sh         # restaure la dernière sauvegarde dans une base
                                        # temporaire et vérifie les effectifs table par table
node infra/test-charge.mjs             # test de charge du chemin de lecture de l'API
```

### Vérifier le mode hors ligne

1. Ouvrir <http://localhost:3100> et laisser le service worker s'installer.
2. Construire et lancer en production (`pnpm --filter @fneplus/web build && pnpm --filter @fneplus/web start`).
3. **Arrêter le serveur.**
4. Recharger la page : l'application s'ouvre, et le bouton d'émission produit une facture
   numérotée, calculée et chaînée, sans aucun appel réseau.

### Vérifier la synchronisation

1. Se connecter, puis **arrêter l'API**.
2. Créer un client et émettre des factures : le bandeau affiche « N en attente ».
3. Redémarrer l'API : tout part au retour du réseau, et le statut des factures
   passe de « Gardée sur l'appareil » à « En cours d'envoi à la DGI ».
4. Relancer l'envoi plusieurs fois : aucun doublon n'est créé côté serveur.

---

## Organisation du dépôt

```
apps/
  web/        PWA mobile-first (Next.js) — le terminal de facturation
  api/        API NestJS multi-tenant (auth, référentiels, synchronisation)
  dgi-sim/    Simulateur de l'API FNE, avec injection de latence et de pannes
packages/
  core/       Domaine partagé client/serveur : TVA, numérotation, intégrité, horloge
  ui/         Design system (jetons CSS + composants)
  tsconfig/   Configurations TypeScript communes
infra/        docker-compose de développement
docs/         Plan de développement et décisions
```

### Pourquoi un package `core` partagé

Le calcul de TVA et les règles de validation d'une facture s'exécutent **deux fois** : sur
le terminal au moment de l'émission hors ligne, et sur le serveur à la réception. Les deux
doivent donner exactement le même résultat, sinon une facture parfaitement légitime part en
rejet. Ce code est donc écrit une seule fois, dans `packages/core`, et importé des deux
côtés.

---

## Décisions structurantes

**La base locale est la source de vérité.** L'application lit et écrit dans SQLite sur
l'appareil. Le serveur n'est pas une base distante que l'on interroge, c'est un pair avec
lequel on réconcilie. Le réseau n'est jamais dans le chemin critique de l'utilisateur.

**SQLite tourne dans un Web Worker.** Le VFS OPFS `sahpool` repose sur
`createSyncAccessHandle()`, qui n'existe que dans un worker. C'est aussi ce qui garde la
caisse réactive pendant une écriture disque. Le worker n'expose pas de SQL mais des
opérations métier complètes, ce qui garde chaque transaction indivisible.

**Les numéros de facture sont pré-alloués par terminal.** Une séquence sans trou et des
terminaux déconnectés sont deux exigences contradictoires ; la réserve allouée par appareil
les réconcilie, et rend toute collision impossible.

**Le référentiel fiscal est versionné par date d'effet.** Un taux n'est jamais écrit en dur.
Une facture rectificative émise en 2027 pour une facture de 2026 recalcule avec le
référentiel de 2026.

**L'isolation entre entreprises est portée par PostgreSQL.** Row Level Security
sur toutes les tables métier, avec un rôle applicatif qui ne la contourne pas. Un
`WHERE entreprise_id = ?` oublié ne fuite rien : il ne renvoie simplement aucune
ligne.

**Une commande de synchronisation est idempotente.** Chaque commande porte un
UUIDv7 généré sur l'appareil, enregistré côté serveur avant application. Un lot
rejoué après une coupure en plein envoi retrouve son résultat au lieu de créer un
doublon — c'est le cas courant sur un réseau mobile qui lâche au milieu d'un POST.

**Les conflits se tranchent sur l'horodatage logique, pas sur l'heure d'arrivée.**
Un terminal resté trois jours hors ligne n'écrase pas une correction plus récente
faite ailleurs simplement parce qu'il se reconnecte après.

**Le stockage local est déclaré persistant.** Sans `navigator.storage.persist()`,
le navigateur peut effacer les factures en attente de transmission. L'application
le demande, l'affiche, et prévient quand le navigateur a refusé.

**Le QR est produit hors ligne et se déclare provisoire.** Tant que la DGI n'a pas
certifié la facture, le code remis au client prouve son intégrité mais ne porte pas
l'identifiant officiel — et l'interface le dit, plutôt que de laisser croire à une
conformité acquise.

**Ce que le terminal ne peut pas réparer, il le montre.** Facture refusée, envoi
abandonné, réserve de numéros épuisée : chaque anomalie dit ce qui s'est passé et
quoi faire. Une file d'attente qui grossit en silence se découvre le jour du
contrôle fiscal.

**Une facture en file n'en sort que certifiée ou explicitement rejetée.** La file
de transmission vit dans PostgreSQL, dans la même transaction que la facture : ni
une panne de cache ni un redémarrage ne peuvent perdre une pièce comptable.

**Le budget de poids est vérifié en intégration continue.** Moins de 200 Ko de JavaScript au
premier chargement. Un budget qu'on ne mesure pas est un budget qu'on dépasse — chaque
kilo-octet est payé en données mobiles par l'utilisateur final.

**L'encaissement suit deux chemins distincts, selon leur rapport au réseau.**
Les espèces s'enregistrent hors ligne, dans la même transaction que la facture.
Le mobile money exige le réseau dès la demande — ouvrir une transaction chez un
prestataire externe n'a pas de sens hors ligne — et se règle plus tard, côté
serveur, sur notification du prestataire.

**Le règlement mobile money fait autorité côté serveur, jamais côté terminal.**
Un webhook ne touche jamais l'appareil : l'écran de caisse interroge donc le
serveur pour son état de règlement quand le réseau est là, et ne retombe sur
l'état local que hors ligne. Sans ce recalage, un paiement pourtant confirmé
resterait affiché comme impayé indéfiniment — un bug réel, trouvé en faisant
fonctionner l'application plutôt qu'en lisant ses tests.

**L'alerte de conformité (ARF) se déclenche avant l'échéance, pas le jour même.**
Le commerçant est prévenu 30 jours avant l'expiration de son attestation, pas
seulement une fois qu'il est déjà bloqué.

**Les indicateurs vivent à deux échelles.** Usage et conformité sont une
donnée de compte, lue avec le contexte tenant normal. Adoption et rétention
n'ont de sens qu'agrégées sur toute la plateforme — ce n'est pas une donnée
qu'un rôle métier (propriétaire, caissier, comptable) devrait porter, donc
l'accès passe par un jeton d'exploitation dédié, pas par le système de rôles.

**Un chiffre absent vaut mieux qu'un chiffre inventé.** La satisfaction
(NPS, délai de résolution support) n'a aucune source de données dans
l'application : l'indicateur renvoie `null` avec une explication, plutôt
qu'un zéro qui se lirait comme une performance.

**Une sauvegarde qui n'a jamais été restaurée n'est qu'une hypothèse.**
`infra/tester-restauration.sh` restaure réellement la dernière sauvegarde
dans une base temporaire et compare les effectifs table par table, avant de
la supprimer.

**Le multi-boutiques distingue les droits d'un compte de la donnée qu'il
consulte.** Un caissier rattaché à une boutique ne voit qu'elle ; un
propriétaire ou un comptable voient tout. La vue consolidée vient
nécessairement du serveur — la base locale d'un terminal ne connaît jamais
que sa propre caisse.

**Un avoir retranche du chiffre d'affaires, il ne s'ajoute pas et ne
s'ignore pas.** Un bug pré-existant excluait les avoirs du calcul du jour au
lieu de les soustraire — trouvé en construisant l'écran qui permet enfin de
les émettre, corrigé des deux côtés (terminal et serveur).

---

## Points à confirmer avant la suite

Ces questions conditionnent l'architecture et sont détaillées dans le plan de développement.
La première peut remettre en cause la promesse produit.

1. **Le QR code FNE peut-il être calculé hors ligne**, ou dépend-il d'un identifiant renvoyé
   par la DGI ?
2. Accès au bac à sable de la DGI : **procédure connue** (voir
   `docs/PLAN-DEVELOPPEMENT.md`, §1) — inscription, tests, validation de spécimens par
   `support.fne@dgi.gouv.ci` — reste à exécuter. L'authentification par jeton JWT Bearer
   qu'elle exige est déjà celle que `DgiClient` implémente ; il ne manque que le jeton réel.
3. Périmètre exact de la numérotation séquentielle et tolérance aux plages pré-allouées.
4. Mobile money : agrégateur ou intégration directe par opérateur.
5. Exigence de résidence des données UEMOA et hébergeur retenu.
6. **Délai réglementaire de transmission d'une facture à la DGI, en heures** —
   requis pour vérifier le critère d'acceptation du Sprint 6 (« 95 % des
   factures transmises dans le délai réglementaire »), jamais chiffré dans le
   cahier des charges. Hypothèse de travail : 24 h (`KPI_DELAI_REGLEMENTAIRE_HEURES`).
