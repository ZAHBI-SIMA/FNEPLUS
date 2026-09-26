/**
 * Schéma de la base locale du terminal.
 *
 * Cette base est la source de vérité de l'usage quotidien : l'application lit et
 * écrit ici, toujours, que le réseau soit présent ou non. Le serveur n'est pas
 * une base distante que l'on interroge, c'est un pair avec lequel on réconcilie.
 *
 * Les migrations sont numérotées et appliquées dans l'ordre. On n'en supprime
 * jamais une : un terminal peut rester trois semaines sans mise à jour et
 * arriver avec une version très ancienne.
 */

export interface Migration {
  version: number;
  nom: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    nom: 'socle',
    sql: `
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS meta (
        cle   TEXT PRIMARY KEY,
        valeur TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entreprises (
        id             TEXT PRIMARY KEY,
        ncc            TEXT NOT NULL,
        raison_sociale TEXT NOT NULL,
        regime_fiscal  TEXT NOT NULL,
        adresse        TEXT NOT NULL DEFAULT '',
        telephone      TEXT NOT NULL DEFAULT '',
        email          TEXT,
        maj_le         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS points_de_vente (
        id            TEXT PRIMARY KEY,
        entreprise_id TEXT NOT NULL REFERENCES entreprises(id),
        libelle       TEXT NOT NULL,
        code          TEXT NOT NULL,
        adresse       TEXT
      );

      CREATE TABLE IF NOT EXISTS terminaux (
        id                TEXT PRIMARY KEY,
        entreprise_id     TEXT NOT NULL REFERENCES entreprises(id),
        point_de_vente_id TEXT NOT NULL REFERENCES points_de_vente(id),
        libelle           TEXT NOT NULL,
        revoque_le        TEXT
      );

      CREATE TABLE IF NOT EXISTS clients (
        id            TEXT PRIMARY KEY,
        entreprise_id TEXT NOT NULL REFERENCES entreprises(id),
        nom           TEXT NOT NULL,
        ncc           TEXT,
        telephone     TEXT,
        email         TEXT,
        adresse       TEXT,
        -- Horodatage HLC sérialisé : arbitre les conflits de modification
        -- entre deux terminaux ayant travaillé hors ligne simultanément.
        hlc           TEXT NOT NULL,
        supprime      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_clients_nom ON clients(entreprise_id, nom);

      CREATE TABLE IF NOT EXISTS produits (
        id               TEXT PRIMARY KEY,
        entreprise_id    TEXT NOT NULL REFERENCES entreprises(id),
        designation      TEXT NOT NULL,
        prix_unitaire_ht INTEGER NOT NULL,
        code_tva         TEXT NOT NULL,
        reference        TEXT,
        hlc              TEXT NOT NULL,
        supprime         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_produits_designation
        ON produits(entreprise_id, designation);

      -- Réserve de numéros allouée par le serveur à CE terminal.
      CREATE TABLE IF NOT EXISTS plages_numeros (
        id                TEXT PRIMARY KEY,
        entreprise_id     TEXT NOT NULL,
        point_de_vente_id TEXT NOT NULL,
        terminal_id       TEXT NOT NULL,
        prefixe           TEXT NOT NULL,
        debut             INTEGER NOT NULL,
        fin               INTEGER NOT NULL,
        curseur           INTEGER NOT NULL,
        longueur_compteur INTEGER NOT NULL,
        allouee_le        TEXT NOT NULL,
        cloturee_le       TEXT
      );

      CREATE TABLE IF NOT EXISTS factures (
        id                  TEXT PRIMARY KEY,
        entreprise_id       TEXT NOT NULL,
        point_de_vente_id   TEXT NOT NULL,
        terminal_id         TEXT NOT NULL,
        type                TEXT NOT NULL,
        statut              TEXT NOT NULL,
        numero              TEXT NOT NULL,
        emise_le            TEXT NOT NULL,
        horodatage_certifie TEXT,
        client_id           TEXT,
        client_nom          TEXT NOT NULL,
        client_ncc          TEXT,
        total_ht            INTEGER NOT NULL,
        total_tva           INTEGER NOT NULL,
        total_ttc           INTEGER NOT NULL,
        totaux_json         TEXT NOT NULL,
        version_referentiel TEXT NOT NULL,
        hash_precedent      TEXT NOT NULL,
        hash                TEXT NOT NULL,
        identifiant_dgi     TEXT,
        contenu_qr          TEXT,
        facture_origine_id  TEXT,
        motif_rejet         TEXT
      );
      -- Un numéro ne peut jamais être servi deux fois pour une même entreprise.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_factures_numero
        ON factures(entreprise_id, numero);
      CREATE INDEX IF NOT EXISTS idx_factures_statut
        ON factures(entreprise_id, statut, emise_le DESC);

      CREATE TABLE IF NOT EXISTS lignes_facture (
        id               TEXT PRIMARY KEY,
        facture_id       TEXT NOT NULL REFERENCES factures(id) ON DELETE CASCADE,
        rang             INTEGER NOT NULL,
        designation      TEXT NOT NULL,
        quantite         REAL NOT NULL,
        prix_unitaire_ht INTEGER NOT NULL,
        code_tva         TEXT NOT NULL,
        remise_pourcent  REAL NOT NULL DEFAULT 0,
        produit_id       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lignes_facture ON lignes_facture(facture_id, rang);

      -- File des commandes à pousser au serveur.
      CREATE TABLE IF NOT EXISTS outbox (
        id                     TEXT PRIMARY KEY,
        type                   TEXT NOT NULL,
        entreprise_id          TEXT NOT NULL,
        terminal_id            TEXT NOT NULL,
        hlc                    TEXT NOT NULL,
        creee_le               TEXT NOT NULL,
        charge_json            TEXT NOT NULL,
        etat                   TEXT NOT NULL DEFAULT 'EN_ATTENTE',
        tentatives             INTEGER NOT NULL DEFAULT 0,
        prochaine_tentative_le TEXT,
        derniere_erreur        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_file ON outbox(etat, creee_le);

      -- Référentiels fiscaux mis en cache : indispensables pour calculer une TVA
      -- juste alors que le terminal est déconnecté.
      CREATE TABLE IF NOT EXISTS referentiels_fiscaux (
        version     TEXT PRIMARY KEY,
        date_effet  TEXT NOT NULL,
        date_fin    TEXT,
        contenu_json TEXT NOT NULL,
        recu_le     TEXT NOT NULL
      );

      -- Journal d'audit local, non modifiable par l'interface.
      CREATE TABLE IF NOT EXISTS journal_audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        survenu_le TEXT NOT NULL,
        evenement  TEXT NOT NULL,
        detail_json TEXT
      );
    `,
  },
  {
    version: 2,
    nom: 'encaissement',
    sql: `
      -- État de règlement porté par la facture : ce que lit l'écran de vente
      -- sans avoir à agréger les paiements à chaque affichage.
      ALTER TABLE factures ADD COLUMN montant_regle INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE factures ADD COLUMN reglee_le TEXT;

      CREATE TABLE IF NOT EXISTS paiements (
        id                TEXT PRIMARY KEY,
        entreprise_id     TEXT NOT NULL,
        facture_id        TEXT NOT NULL REFERENCES factures(id) ON DELETE CASCADE,
        moyen             TEXT NOT NULL,
        montant           INTEGER NOT NULL,
        statut            TEXT NOT NULL DEFAULT 'EN_ATTENTE',
        reference_externe TEXT,
        lien_paiement     TEXT,
        telephone         TEXT,
        demande_le        TEXT NOT NULL,
        regle_le          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_paiements_facture ON paiements(facture_id);
    `,
  },
];

export const VERSION_SCHEMA_CIBLE = MIGRATIONS[MIGRATIONS.length - 1]!.version;
