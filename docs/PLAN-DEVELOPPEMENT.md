# FNE+ — Plan de développement

> Document de travail dérivé du `Cahier-des-charges-FNE-plus.pdf` (v1.0, 22/09/2026).
> Statut : proposition à valider avant écriture de code.

---

## 0. Lecture du besoin et principe directeur

Le cahier des charges est clair sur un point : **l'angle produit n'est pas la facturation, c'est le hors-ligne.**
Tout le reste (TVA, QR, archivage, mobile money) existe déjà chez Kompto, CassKai et fne.ci.

Conséquence sur le plan : le mode hors-ligne n'est **pas un lot séparé en fin de MVP**. Il est une
contrainte d'architecture posée dès la première ligne de code. On ne construit pas une app en ligne
que l'on « offline-ise » ensuite — c'est une réécriture assurée. On construit une app locale qui se
synchronise.

**Règle d'or du projet :** toute opération courante (créer un client, émettre une facture, encaisser,
consulter l'historique du jour) s'exécute intégralement contre la base locale du terminal. Le réseau
n'est jamais dans le chemin critique de l'utilisateur.

---

## 1. Hypothèses et points bloquants à confirmer

Ces points conditionnent l'architecture. Ils sont listés en tête car certains doivent être levés
**avant** le sprint 4, et un seul (le premier) peut remettre en cause la promesse produit.

| #   | Point                                                                                                                                                                                                                                                                | Impact si non levé                                | Échéance  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------- |
| 1   | **Le QR code FNE peut-il être calculé hors ligne ?** Si la DGI renvoie un identifiant de certification qui doit figurer dans le QR, la promesse « QR remis au client sans attendre la connexion » exige une négociation (plages pré-certifiées) ou un QR provisoire. | Risque produit majeur                             | Semaine 1 |
| 2   | Accès au bac à sable (sandbox) de `fne.dgi.gouv.ci` : spécification, authentification, quotas, SLA.                                                                                                                                                                  | Développement à l'aveugle sur simulateur          | Semaine 2 |
| 3   | Règles de numérotation séquentielle : périmètre de la séquence (entreprise ? point de vente ? terminal ?) et tolérance aux plages pré-allouées.                                                                                                                      | Non-conformité de la numérotation hors-ligne      | Semaine 2 |
| 4   | Mobile money : agrégateur (CinetPay, PayDunya, Hub2) ou intégration directe Orange / MTN / Wave / Moov.                                                                                                                                                              | Délai d'accès aux API opérateurs (2 à 8 semaines) | Semaine 3 |
| 5   | Hébergement : exigence exacte de résidence des données UEMOA, et hébergeur retenu à Abidjan.                                                                                                                                                                         | Rejet réglementaire tardif, migration coûteuse    | Semaine 3 |
| 6   | Modèle tarifaire et facturation des cabinets comptables (marque blanche).                                                                                                                                                                                            | Impacte le modèle multi-tenant                    | Avant V2  |

**Hypothèse de travail en attendant :** on développe contre un **simulateur DGI** fidèle à la
spécification publique, derrière une couche d'anticorruption. Le passage à l'API réelle ne touche
alors qu'un module isolé.

---

## 2. Décisions d'architecture

### 2.1 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│  CLIENT — PWA mobile-first (Next.js + TypeScript)       │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Base locale SQLite WASM (OPFS)  ← source de      │  │
│  │  vérité pour l'usage quotidien                    │  │
│  │  + Outbox (file de commandes à pousser)           │  │
│  │  + Plages de numéros pré-allouées                 │  │
│  └───────────────────────────────────────────────────┘  │
│  Service Worker : cache applicatif, sync en arrière-plan│
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS (delta sync, compressé)
┌──────────────────────┴──────────────────────────────────┐
│  API — NestJS, API-first, multi-tenant (Postgres RLS)   │
│  Auth · Facturation · TVA · Clients · Reporting         │
└───────┬──────────────────┬──────────────────┬───────────┘
        │                  │                  │
┌───────┴────────┐ ┌───────┴────────┐ ┌───────┴────────┐
│ Connecteur DGI │ │ Passerelle     │ │ Archivage      │
│ service isolé  │ │ paiement       │ │ WORM +         │
│ file + rejeu   │ │ OM/MTN/Wave    │ │ chaîne de hash │
└────────────────┘ └────────────────┘ └────────────────┘
```

### 2.2 Choix techniques et justification

| Couche            | Choix                                                                                     | Pourquoi ce choix pour ce marché                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client            | **PWA Next.js 15 + TypeScript + Tailwind + shadcn/ui**                                    | Pas de téléchargement d'APK lourd sur forfait data limité (exigence explicite du CDC). Budget : < 200 Ko de JS au premier chargement.                                                                           |
| Base locale       | **SQLite WASM sur OPFS** (`@sqlite.org/sqlite-wasm`), repli IndexedDB via Dexie           | Le CDC recommande SQLite embarqué. Du SQL local = requêtes de reporting hors ligne sans réimplémenter un moteur.                                                                                                |
| Packaging Android | **Capacitor** (V2, optionnel)                                                             | Publication Play Store et accès SMS/USSD natif si ce canal est confirmé, sans réécrire l'app.                                                                                                                   |
| Backend           | **NestJS (TypeScript), monorepo pnpm + Turborepo**                                        | Types partagés client/serveur : le calcul de TVA et les règles de validation de facture sont écrits **une seule fois** dans un package commun et exécutés des deux côtés. C'est indispensable en offline-first. |
| Base serveur      | **PostgreSQL 16, multi-tenant par `tenant_id` + Row Level Security**                      | Isolation stricte exigée par le CDC, sans le coût d'une base par client.                                                                                                                                        |
| Files             | **Redis + BullMQ**                                                                        | File de transmission DGI, rejeu, webhooks de paiement.                                                                                                                                                          |
| Auth              | **OTP SMS + code PIN** (usage boutique), TOTP pour comptes multi-utilisateurs et cabinets | Le mot de passe long est un frein réel sur clavier de smartphone d'entrée de gamme.                                                                                                                             |
| Observabilité     | OpenTelemetry + Grafana/Loki, Sentry                                                      | Mesurer le délai de synchronisation, qui est un KPI produit du CDC.                                                                                                                                             |
| CI/CD             | GitHub Actions → conteneurs → hébergeur UEMOA                                             | —                                                                                                                                                                                                               |

### 2.3 Trois mécanismes critiques

**a) Numérotation séquentielle infalsifiable, hors ligne**

Le conflit est frontal : séquence sans trou contre terminaux déconnectés. Solution retenue :
**plages de numéros pré-allouées par terminal.** Chaque appareil télécharge, quand il est en ligne,
un bloc réservé côté serveur (par exemple 500 numéros). Hors ligne, il consomme son bloc — aucune
collision possible entre terminaux. Une alerte se déclenche sous le seuil de 20 % du bloc restant.
Les blocs non consommés sont clôturés et journalisés à la synchronisation.

**b) Chaîne d'intégrité de l'archivage**

Chaque facture stocke le hash de la précédente pour l'entreprise (`prev_hash`), formant une chaîne
vérifiable. Sceau d'horodatage RFC 3161 auprès d'une autorité, et stockage objet en mode WORM
(verrouillage en écriture). Un endpoint de vérification rejoue la chaîne et prouve qu'aucune facture
n'a été supprimée ni modifiée — c'est exactement ce que demande le portail agent DGI.

**c) Horloge et ordonnancement**

L'horloge d'un smartphone d'entrée de gamme est peu fiable. On utilise une **horloge logique hybride
(HLC)** : dérive mesurée à chaque contact serveur, horodatage certifié posé côté serveur à la
réception, horodatage local conservé comme métadonnée d'audit.

---

## 3. Stratégie de synchronisation

**Modèle : outbox + journal de commandes, réconciliation côté serveur.**

1. Toute action utilisateur devient une **commande** persistée localement (`CreateInvoice`,
   `RecordPayment`, `UpsertCustomer`…) avec une clé d'idempotence (UUIDv7 généré sur l'appareil).
2. La commande est appliquée immédiatement à la base locale → l'interface répond en moins de 2 s,
   réseau ou pas.
3. Le Service Worker pousse l'outbox dès le retour du réseau (Background Sync API), par lots
   compressés, avec repli exponentiel.
4. Le serveur applique les commandes de façon idempotente, puis renvoie un delta d'état.

**Conflits.** Les factures sont _append-only_ : une facture émise ne se modifie pas, elle s'annule par
un avoir. Il n'y a donc **aucun conflit sur l'objet central** — c'est ce qui rend l'offline-first
réaliste ici. Les conflits résiduels portent sur les référentiels (client, produit, prix) : résolution
champ par champ, dernière écriture gagnante selon l'HLC, avec journal d'audit consultable et écran
« éléments à vérifier » plutôt qu'un écrasement silencieux.

**États visibles par l'utilisateur** (un seul indicateur, toujours à l'écran) :
`Brouillon → Émise localement → En file DGI → Transmise → Certifiée`, et `Rejetée` avec le motif en
français clair et l'action corrective proposée.

---

## 4. Découpage en lots — MVP (0 à 3 mois, 6 sprints de 2 semaines)

Chaque sprint se termine par un livrable démontrable et des critères d'acceptation mesurables.

### Sprint 0 — Socle (semaines 1-2)

- Monorepo, CI/CD, environnements (dev / staging / prod), conteneurisation.
- Design system mobile-first : tokens, composants de base, mode économie de données, cibles tactiles ≥ 48 px.
- Squelette PWA + base SQLite locale + schéma initial.
- **Simulateur DGI** conforme à la spécification publique.
- En parallèle (non technique) : démarches d'accès API DGI et mobile money.
- _Acceptation :_ l'app s'installe depuis le navigateur, s'ouvre hors ligne, poids initial < 200 Ko de JS.

### Sprint 1 — Identité et référentiels (semaines 3-4)

- Inscription entreprise : NCC, régime fiscal (micro / réel simplifié / réel normal), points de vente.
- Auth OTP SMS + PIN, rôles (propriétaire, caissier, comptable), multi-tenant avec RLS.
- Clients et catalogue produits, fonctionnels hors ligne, avec première synchronisation.
- _Acceptation :_ un caissier crée un client en mode avion ; le client apparaît côté serveur au retour du réseau, sans doublon.

### Sprint 2 — Moteur de facturation (semaines 5-6)

- Moteur de calcul TVA multi-régimes, paramétrage **versionné avec dates d'effet** (taux et seuils
  modifiables sans redéploiement — répond à l'exigence de veille réglementaire).
- Types de documents : facture, avoir, acompte, facture rectificative.
- Numérotation par plages pré-allouées, génération QR et PDF/A en local.
- _Acceptation :_ facture émise en moins de 30 s sur le parcours complet, rendu en moins de 2 s sur 3G dégradée, mesuré sur un appareil réel de type Android Go.

### Sprint 3 — Hors-ligne durci (semaines 7-8)

- Outbox, synchronisation delta, Background Sync, reprise après coupure en cours d'envoi.
- Résolution de conflits sur référentiels et écran « à vérifier ».
- Gestion de l'épuisement des plages de numéros, purge et quotas de stockage local.
- **Campagne de test réseau adverse** : perte de paquets, latence 2 s, coupure en plein envoi, appareil éteint pendant la synchronisation, horloge déréglée.
- _Acceptation :_ 500 factures émises hors ligne sur 72 h se synchronisent sans perte, sans doublon et sans trou de séquence.

### Sprint 4 — Connecteur DGI et archivage (semaines 9-10)

- Service isolé, file de transmission, rejeu automatique, disjoncteur, file d'échecs définitifs.
- Couche d'anticorruption : mapping versionné entre modèle interne et schéma DGI.
- Accusés de réception, statuts, traitement des rejets avec message en français clair.
- Archivage : chaîne de hash, horodatage RFC 3161, stockage WORM, export de contrôle fiscal.
- _Acceptation :_ API DGI coupée 6 h → aucune perte, rejeu automatique complet au rétablissement ; l'export de contrôle est vérifiable de bout en bout.

### Sprint 5 — Encaissement et pilotage (semaines 11-12)

- Mobile money : lien ou QR de paiement Orange Money, MTN, Wave, Moov ; webhooks de confirmation ; rapprochement automatique.
- Suivi ARF : tableau de bord permanent et alerte avant rupture de conformité.
- Tableau de bord : chiffre d'affaires, TVA collectée, factures en attente de transmission.
- _Acceptation :_ un paiement mobile money marque la facture réglée en moins de 60 s, sans intervention manuelle.

### Sprint 6 — Durcissement et pilote (semaines 13-14)

- Audit de sécurité, test de charge, plan de sauvegarde **testé par restauration réelle**.
- Instrumentation des KPI du chapitre 10 du CDC (adoption, usage, part hors ligne, délai de synchronisation).
- Base de connaissance, support WhatsApp et chat, parcours d'aide intégré.
- **Pilote terrain : 10 à 20 entreprises à Abidjan**, dont au moins 3 en zone à connectivité faible.
- _Acceptation :_ disponibilité 99,5 % sur 2 semaines de pilote ; 95 % des factures transmises dans le délai réglementaire.

---

## 5. V2 (3 à 6 mois) et V3 (6 à 12 mois)

**V2 — deux chantiers parallélisables par deux binômes :**

- _Élargissement des canaux :_ USSD/SMS (passerelle opérateur), assistant WhatsApp Business, OCR de reçus manuscrits.
- _Élargissement des comptes :_ multi-boutiques consolidé avec droits différenciés, console marque blanche pour cabinets (facturation groupée), premières briques IA (assistant fiscal, détection d'anomalies, catégorisation produits).

_Note sur l'IA :_ les fonctions IA se posent sur l'historique produit par le MVP. La détection
d'anomalies (doublons, ruptures de séquence, écarts de prix) démarre en **règles déterministes** —
mesurables, explicables, défendables devant un contrôle — avant tout modèle appris. L'assistant fiscal
est un RAG sur la documentation DGI, avec réponses systématiquement sourcées.

**V3 :** financement sur factures (partenariat fintech), signature électronique qualifiée, passerelle
multi-pays UEMOA (le paramétrage fiscal versionné du sprint 2 est la fondation de cette extension),
prévision de trésorerie et de TVA.

---

## 6. Qualité et sécurité

- **Tests :** unitaires sur le moteur TVA et la numérotation (couverture visée supérieure à 90 % sur
  ces deux modules — ce sont les seuls où un bug est un risque fiscal pour le client) ; tests
  d'intégration sur le connecteur DGI ; tests end-to-end Playwright avec réseau simulé ; tests sur
  appareils physiques d'entrée de gamme, pas seulement en émulateur.
- **Sécurité :** chiffrement au repos et en transit, chiffrement de la base locale, révocation
  d'appareil à distance (terminal de boutique perdu), journal d'audit inaltérable, conformité à la loi
  ivoirienne sur la protection des données personnelles, audit externe avant lancement commercial.
- **Exploitation :** sauvegardes chiffrées quotidiennes avec restauration testée mensuellement,
  objectifs RPO 1 h et RTO 4 h, astreinte aux horaires d'activité locaux.

---

## 7. Première étape concrète

Si ce plan est validé, j'enchaîne sur le **Sprint 0** :
initialisation du monorepo, design system mobile-first, squelette PWA avec base SQLite locale
fonctionnelle hors ligne, et simulateur DGI — de quoi démontrer dès la fin du sprint une application
qui s'ouvre et fonctionne en mode avion.
