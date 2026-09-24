-- Socle multi-tenant.
--
-- Isolation : une seule base, une seule instance, mais chaque requête ne voit
-- que les données de son entreprise. L'isolation n'est pas portée par le code
-- applicatif (où un `WHERE entreprise_id = ?` oublié suffit à fuiter les données
-- d'un concurrent) mais par PostgreSQL lui-même, via Row Level Security.
--
-- Le contrat est simple : toute connexion applicative pose
-- `SET LOCAL fneplus.entreprise_id = '...'` au début de sa transaction. Sans ce
-- réglage, les politiques ne laissent rien passer.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Rôle applicatif : il ne contourne PAS la RLS, contrairement au propriétaire
-- des tables. C'est ce qui rend l'isolation réellement contraignante.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fneplus_app') THEN
    CREATE ROLE fneplus_app LOGIN PASSWORD 'fneplus_app_dev';
  END IF;
END
$$;

/* ------------------------------------------------------------------ */
/* Référentiel fiscal — donnée globale, hors périmètre tenant          */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS referentiels_fiscaux (
  version      TEXT PRIMARY KEY,
  date_effet   DATE NOT NULL,
  date_fin     DATE,
  contenu      JSONB NOT NULL,
  publie_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referentiels_effet
  ON referentiels_fiscaux (date_effet DESC);

/* ------------------------------------------------------------------ */
/* Entreprises et structure                                            */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS entreprises (
  id             UUID PRIMARY KEY,
  ncc            TEXT NOT NULL UNIQUE,
  raison_sociale TEXT NOT NULL,
  regime_fiscal  TEXT NOT NULL
    CHECK (regime_fiscal IN ('ENTREPRENANT','MICROENTREPRISE','REEL_SIMPLIFIE','REEL_NORMAL')),
  adresse        TEXT NOT NULL DEFAULT '',
  telephone      TEXT NOT NULL,
  email          TEXT,
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS points_de_vente (
  id            UUID PRIMARY KEY,
  entreprise_id UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  libelle       TEXT NOT NULL,
  code          TEXT NOT NULL,
  adresse       TEXT,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, code)
);

CREATE TABLE IF NOT EXISTS terminaux (
  id                UUID PRIMARY KEY,
  entreprise_id     UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  point_de_vente_id UUID NOT NULL REFERENCES points_de_vente(id) ON DELETE CASCADE,
  libelle           TEXT NOT NULL,
  -- Empreinte de l'appareil : permet de repérer un terminal qui réapparaît
  -- après une réinstallation, et de révoquer un appareil perdu.
  empreinte         TEXT,
  appaire_le        TIMESTAMPTZ NOT NULL DEFAULT now(),
  vu_le             TIMESTAMPTZ,
  revoque_le        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_terminaux_entreprise ON terminaux (entreprise_id);

/* ------------------------------------------------------------------ */
/* Utilisateurs                                                        */
/* ------------------------------------------------------------------ */

-- Identifiant : le numéro de téléphone. Pas d'e-mail obligatoire — beaucoup de
-- commerçants n'en utilisent pas, et en exiger un ferait abandonner à l'inscription.
CREATE TABLE IF NOT EXISTS utilisateurs (
  id            UUID PRIMARY KEY,
  entreprise_id UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  telephone     TEXT NOT NULL,
  nom           TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('PROPRIETAIRE','CAISSIER','COMPTABLE')),
  -- PIN haché avec scrypt. Jamais le PIN en clair, même en développement.
  pin_hash      TEXT,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  desactive_le  TIMESTAMPTZ,
  UNIQUE (entreprise_id, telephone)
);

-- Un même numéro ne peut pas ouvrir deux comptes actifs : sinon l'envoi d'un
-- code OTP devient ambigu.
CREATE UNIQUE INDEX IF NOT EXISTS idx_utilisateurs_telephone_actif
  ON utilisateurs (telephone) WHERE desactive_le IS NULL;

-- Codes OTP. Hors périmètre tenant : au moment de la demande, on ne sait pas
-- encore à quelle entreprise appartient l'appelant.
CREATE TABLE IF NOT EXISTS codes_otp (
  id          UUID PRIMARY KEY,
  telephone   TEXT NOT NULL,
  -- Le code est haché : une fuite de la base ne doit pas permettre de se
  -- connecter à la place d'un commerçant.
  code_hash   TEXT NOT NULL,
  expire_le   TIMESTAMPTZ NOT NULL,
  tentatives  INTEGER NOT NULL DEFAULT 0,
  consomme_le TIMESTAMPTZ,
  cree_le     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_telephone ON codes_otp (telephone, cree_le DESC);

/* ------------------------------------------------------------------ */
/* Plages de numéros                                                   */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS plages_numeros (
  id                UUID PRIMARY KEY,
  entreprise_id     UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  point_de_vente_id UUID NOT NULL REFERENCES points_de_vente(id) ON DELETE CASCADE,
  terminal_id       UUID NOT NULL REFERENCES terminaux(id) ON DELETE CASCADE,
  prefixe           TEXT NOT NULL,
  debut             BIGINT NOT NULL,
  fin               BIGINT NOT NULL,
  longueur_compteur INTEGER NOT NULL DEFAULT 6,
  allouee_le        TIMESTAMPTZ NOT NULL DEFAULT now(),
  cloturee_le       TIMESTAMPTZ,
  numeros_non_utilises INTEGER,
  CHECK (fin >= debut)
);

-- Deux plages d'un même point de vente ne peuvent jamais se chevaucher : c'est
-- la garantie, au niveau de la base, qu'aucun numéro ne sera servi deux fois.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE plages_numeros DROP CONSTRAINT IF EXISTS plages_sans_chevauchement;
ALTER TABLE plages_numeros ADD CONSTRAINT plages_sans_chevauchement
  EXCLUDE USING gist (
    point_de_vente_id WITH =,
    prefixe WITH =,
    int8range(debut, fin, '[]') WITH &&
  );

CREATE INDEX IF NOT EXISTS idx_plages_terminal ON plages_numeros (terminal_id);

/* ------------------------------------------------------------------ */
/* Référentiels métier                                                 */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY,
  entreprise_id UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  nom           TEXT NOT NULL,
  ncc           TEXT,
  telephone     TEXT,
  email         TEXT,
  adresse       TEXT,
  -- Horodatage logique hybride sérialisé. Arbitre les modifications concurrentes
  -- entre terminaux ayant travaillé hors ligne : la plus récente gagne, champ
  -- par champ, et l'ancienne est journalisée plutôt qu'écrasée en silence.
  hlc           TEXT NOT NULL,
  supprime      BOOLEAN NOT NULL DEFAULT false,
  maj_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clients_entreprise ON clients (entreprise_id, maj_le DESC);

CREATE TABLE IF NOT EXISTS produits (
  id               UUID PRIMARY KEY,
  entreprise_id    UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  designation      TEXT NOT NULL,
  prix_unitaire_ht BIGINT NOT NULL CHECK (prix_unitaire_ht >= 0),
  code_tva         TEXT NOT NULL,
  reference        TEXT,
  hlc              TEXT NOT NULL,
  supprime         BOOLEAN NOT NULL DEFAULT false,
  maj_le           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_produits_entreprise ON produits (entreprise_id, maj_le DESC);

/* ------------------------------------------------------------------ */
/* Factures                                                            */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS factures (
  id                  UUID PRIMARY KEY,
  entreprise_id       UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  point_de_vente_id   UUID NOT NULL,
  terminal_id         UUID NOT NULL,
  type                TEXT NOT NULL,
  statut              TEXT NOT NULL,
  numero              TEXT NOT NULL,
  emise_le            TIMESTAMPTZ NOT NULL,
  horodatage_certifie TIMESTAMPTZ,
  client_id           UUID,
  client_nom          TEXT NOT NULL,
  client_ncc          TEXT,
  total_ht            BIGINT NOT NULL,
  total_tva           BIGINT NOT NULL,
  total_ttc           BIGINT NOT NULL,
  totaux              JSONB NOT NULL,
  lignes              JSONB NOT NULL,
  version_referentiel TEXT NOT NULL,
  hash_precedent      TEXT NOT NULL,
  hash                TEXT NOT NULL,
  identifiant_dgi     TEXT,
  contenu_qr          TEXT,
  facture_origine_id  UUID,
  motif_rejet         TEXT,
  recue_le            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_factures_statut
  ON factures (entreprise_id, statut, emise_le DESC);

/* ------------------------------------------------------------------ */
/* Idempotence de la synchronisation                                   */
/* ------------------------------------------------------------------ */

-- Toute commande poussée par un terminal est enregistrée ici avant d'être
-- appliquée. Un lot rejoué après une coupure en plein envoi retrouve son
-- résultat au lieu de créer un doublon.
CREATE TABLE IF NOT EXISTS commandes_traitees (
  id            UUID PRIMARY KEY,
  entreprise_id UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  terminal_id   UUID NOT NULL,
  type          TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  resultat      JSONB NOT NULL,
  traitee_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commandes_entreprise
  ON commandes_traitees (entreprise_id, traitee_le DESC);

/* ------------------------------------------------------------------ */
/* Row Level Security                                                  */
/* ------------------------------------------------------------------ */

-- `fneplus.entreprise_id` est posé par l'application au début de chaque
-- transaction. `current_setting(..., true)` renvoie NULL s'il est absent, et la
-- comparaison échoue alors pour toutes les lignes : pas de réglage, pas d'accès.
CREATE OR REPLACE FUNCTION fneplus_entreprise_courante() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('fneplus.entreprise_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE;

DO $$
DECLARE
  nom_table TEXT;
BEGIN
  FOREACH nom_table IN ARRAY ARRAY[
    'entreprises','points_de_vente','terminaux','utilisateurs','plages_numeros',
    'clients','produits','factures','commandes_traitees'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nom_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', nom_table);
    EXECUTE format('DROP POLICY IF EXISTS isolation_tenant ON %I', nom_table);

    IF nom_table = 'entreprises' THEN
      EXECUTE format(
        'CREATE POLICY isolation_tenant ON %I USING (id = fneplus_entreprise_courante())
           WITH CHECK (id = fneplus_entreprise_courante())', nom_table);
    ELSE
      EXECUTE format(
        'CREATE POLICY isolation_tenant ON %I USING (entreprise_id = fneplus_entreprise_courante())
           WITH CHECK (entreprise_id = fneplus_entreprise_courante())', nom_table);
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fneplus_app', nom_table);
  END LOOP;
END
$$;

-- Tables hors périmètre tenant : lecture libre pour le référentiel fiscal,
-- accès complet aux codes OTP (la requête n'a pas encore d'entreprise connue).
GRANT SELECT ON referentiels_fiscaux TO fneplus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON codes_otp TO fneplus_app;
