-- File de transmission à la DGI et archivage légal.
--
-- La file vit dans PostgreSQL, pas dans Redis. Ces factures sont des pièces
-- comptables : leur file doit survivre à une perte du cache comme à un
-- redémarrage, et son avancement doit pouvoir être modifié dans la MÊME
-- transaction que la facture qu'elle concerne. Avec deux systèmes séparés, une
-- facture pourrait être marquée certifiée sans que la file l'enregistre, ou
-- l'inverse.

CREATE TABLE IF NOT EXISTS file_transmission (
  facture_id             UUID PRIMARY KEY REFERENCES factures(id) ON DELETE CASCADE,
  entreprise_id          UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  etat                   TEXT NOT NULL DEFAULT 'EN_ATTENTE'
    CHECK (etat IN ('EN_ATTENTE','CERTIFIEE','REJETEE','INTERVENTION_REQUISE')),
  tentatives             INTEGER NOT NULL DEFAULT 0,
  prochaine_tentative_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  derniere_erreur        TEXT,
  version_mapping        TEXT,
  mise_en_file_le        TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminee_le            TIMESTAMPTZ
);

-- Index de travail du connecteur : il ne lit que ce qui est dû maintenant.
-- Partiel, pour qu'il reste petit même avec des millions de factures certifiées.
CREATE INDEX IF NOT EXISTS idx_file_a_traiter
  ON file_transmission (prochaine_tentative_le)
  WHERE etat = 'EN_ATTENTE';

CREATE INDEX IF NOT EXISTS idx_file_entreprise
  ON file_transmission (entreprise_id, etat);

/* ------------------------------------------------------------------ */
/* Archivage légal                                                     */
/* ------------------------------------------------------------------ */

-- Scellés d'archivage.
--
-- Un scellé couvre un ensemble de factures consécutives d'une entreprise et
-- fixe leur état à un instant donné. Il porte l'empreinte de la dernière
-- facture de la période : toute modification ultérieure d'une facture couverte
-- casse la vérification.
--
-- L'horodatage qualifié (RFC 3161) n'est pas encore branché : `jeton_horodatage`
-- reçoit pour l'instant un scellé produit par le serveur, explicitement marqué
-- non qualifié. La contractualisation d'une autorité d'horodatage est un
-- préalable à la mise en production.
CREATE TABLE IF NOT EXISTS scelles_archivage (
  id                UUID PRIMARY KEY,
  entreprise_id     UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  periode_debut     TIMESTAMPTZ NOT NULL,
  periode_fin       TIMESTAMPTZ NOT NULL,
  nombre_factures   INTEGER NOT NULL,
  premiere_facture  TEXT NOT NULL,
  derniere_facture  TEXT NOT NULL,
  -- Empreinte de la dernière facture de la période : point d'ancrage de la chaîne.
  empreinte_finale  TEXT NOT NULL,
  -- Empreinte de l'ensemble scellé, recalculable lors d'un contrôle.
  empreinte_scelle  TEXT NOT NULL,
  jeton_horodatage  TEXT NOT NULL,
  -- Faux tant qu'une autorité d'horodatage qualifiée n'est pas branchée.
  horodatage_qualifie BOOLEAN NOT NULL DEFAULT false,
  scelle_le         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scelles_entreprise
  ON scelles_archivage (entreprise_id, periode_fin DESC);

-- Journal des exports de contrôle fiscal.
--
-- Qui a exporté quoi, quand. Un contrôle qui s'appuie sur un export doit pouvoir
-- être rattaché à une demande tracée.
CREATE TABLE IF NOT EXISTS exports_controle (
  id              UUID PRIMARY KEY,
  entreprise_id   UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  demande_par     UUID,
  motif           TEXT,
  periode_debut   TIMESTAMPTZ NOT NULL,
  periode_fin     TIMESTAMPTZ NOT NULL,
  nombre_factures INTEGER NOT NULL,
  empreinte_export TEXT NOT NULL,
  chaine_valide   BOOLEAN NOT NULL,
  genere_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exports_entreprise
  ON exports_controle (entreprise_id, genere_le DESC);

/* ------------------------------------------------------------------ */
/* Row Level Security                                                  */
/* ------------------------------------------------------------------ */

DO $$
DECLARE
  nom_table TEXT;
BEGIN
  FOREACH nom_table IN ARRAY ARRAY['file_transmission','scelles_archivage','exports_controle']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nom_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', nom_table);
    EXECUTE format('DROP POLICY IF EXISTS isolation_tenant ON %I', nom_table);
    EXECUTE format(
      'CREATE POLICY isolation_tenant ON %I USING (entreprise_id = fneplus_entreprise_courante())
         WITH CHECK (entreprise_id = fneplus_entreprise_courante())', nom_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fneplus_app', nom_table);
  END LOOP;
END
$$;

-- Le connecteur DGI travaille pour toutes les entreprises : il balaie la file
-- sans contexte tenant. Une fonction SECURITY DEFINER lui ouvre une porte
-- étroite, qui ne rend que ce dont il a besoin pour choisir ses prochaines
-- transmissions — jamais le contenu des factures.
CREATE OR REPLACE FUNCTION fneplus_file_a_traiter(p_limite INTEGER)
RETURNS TABLE (facture_id UUID, entreprise_id UUID, tentatives INTEGER)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.facture_id, f.entreprise_id, f.tentatives
    FROM file_transmission f
   WHERE f.etat = 'EN_ATTENTE' AND f.prochaine_tentative_le <= now()
   ORDER BY f.prochaine_tentative_le ASC
   LIMIT p_limite;
$$;

REVOKE ALL ON FUNCTION fneplus_file_a_traiter(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_file_a_traiter(INTEGER) TO fneplus_app;

-- Même principe pour l'avancement de la file, hors contexte tenant.
CREATE OR REPLACE FUNCTION fneplus_file_reporter(
  p_facture_id UUID, p_tentatives INTEGER, p_prochaine TIMESTAMPTZ, p_erreur TEXT
) RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE file_transmission
     SET tentatives = p_tentatives, prochaine_tentative_le = p_prochaine,
         derniere_erreur = p_erreur
   WHERE facture_id = p_facture_id;
$$;

REVOKE ALL ON FUNCTION fneplus_file_reporter(UUID, INTEGER, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_file_reporter(UUID, INTEGER, TIMESTAMPTZ, TEXT) TO fneplus_app;

CREATE OR REPLACE FUNCTION fneplus_file_marquer(
  p_facture_id UUID, p_etat TEXT, p_erreur TEXT
) RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE file_transmission
     SET etat = p_etat, tentatives = tentatives + 1, terminee_le = now(),
         derniere_erreur = p_erreur
   WHERE facture_id = p_facture_id;
$$;

REVOKE ALL ON FUNCTION fneplus_file_marquer(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_file_marquer(UUID, TEXT, TEXT) TO fneplus_app;

CREATE OR REPLACE FUNCTION fneplus_file_etat()
RETURNS TABLE (etat TEXT, n BIGINT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.etat, COUNT(*) FROM file_transmission f GROUP BY f.etat;
$$;

REVOKE ALL ON FUNCTION fneplus_file_etat() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_file_etat() TO fneplus_app;

CREATE OR REPLACE FUNCTION fneplus_file_relancer_interventions()
RETURNS INTEGER
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH relancees AS (
    UPDATE file_transmission
       SET etat = 'EN_ATTENTE', tentatives = 0, prochaine_tentative_le = now()
     WHERE etat = 'INTERVENTION_REQUISE'
    RETURNING facture_id
  )
  SELECT COUNT(*)::INTEGER FROM relancees;
$$;

REVOKE ALL ON FUNCTION fneplus_file_relancer_interventions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_file_relancer_interventions() TO fneplus_app;
