# FNE+

Plateforme de facturation électronique conforme FNE pour les TPE/PME de Côte d'Ivoire.

**Le produit se distingue par une seule chose : il fonctionne sans réseau.** Le socle
réglementaire est déjà occupé par plusieurs acteurs ; le hors-ligne ne l'est pas. Toute
l'architecture découle de ce choix.

- Cahier des charges : `input/Cahier-des-charges-FNE-plus.pdf` (document interne, non publié)
- Plan de développement : [`docs/PLAN-DEVELOPPEMENT.md`](docs/PLAN-DEVELOPPEMENT.md)

---

## État d'avancement

| Sprint | Contenu                                                         | Statut     |
| ------ | --------------------------------------------------------------- | ---------- |
| 0      | Socle : monorepo, design system, PWA hors ligne, simulateur DGI | ✅ terminé |
| 1      | Identité, auth OTP, référentiels clients/produits, multi-tenant | ✅ terminé |
| 2      | Moteur de facturation, TVA multi-régimes, QR et PDF             | à venir    |
| 3      | Hors-ligne durci : outbox, synchronisation, conflits            | à venir    |
| 4      | Connecteur DGI et archivage légal                               | à venir    |
| 5      | Mobile money, suivi ARF, tableau de bord                        | à venir    |
| 6      | Durcissement, pilote terrain à Abidjan                          | à venir    |

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
pnpm infra:up                          # PostgreSQL + Redis
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

**Le budget de poids est vérifié en intégration continue.** Moins de 200 Ko de JavaScript au
premier chargement. Un budget qu'on ne mesure pas est un budget qu'on dépasse — chaque
kilo-octet est payé en données mobiles par l'utilisateur final.

---

## Points à confirmer avant la suite

Ces questions conditionnent l'architecture et sont détaillées dans le plan de développement.
La première peut remettre en cause la promesse produit.

1. **Le QR code FNE peut-il être calculé hors ligne**, ou dépend-il d'un identifiant renvoyé
   par la DGI ?
2. Accès au bac à sable de `fne.dgi.gouv.ci` : spécification, authentification, quotas.
3. Périmètre exact de la numérotation séquentielle et tolérance aux plages pré-allouées.
4. Mobile money : agrégateur ou intégration directe par opérateur.
5. Exigence de résidence des données UEMOA et hébergeur retenu.
