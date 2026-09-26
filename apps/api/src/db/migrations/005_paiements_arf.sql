-- Encaissement mobile money et suivi de l'Attestation de Régularité Fiscale.

/* ------------------------------------------------------------------ */
/* Paiements                                                           */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS paiements (
  id              UUID PRIMARY KEY,
  entreprise_id   UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  facture_id      UUID NOT NULL REFERENCES factures(id) ON DELETE CASCADE,
  moyen           TEXT NOT NULL
    CHECK (moyen IN ('ESPECES','ORANGE_MONEY','MTN_MOMO','WAVE','MOOV_MONEY','VIREMENT','AUTRE')),
  montant         BIGINT NOT NULL CHECK (montant > 0),
  statut          TEXT NOT NULL DEFAULT 'EN_ATTENTE'
    CHECK (statut IN ('EN_ATTENTE','REGLEE','ABANDONNEE','REFUSEE')),
  -- Référence chez le prestataire de paiement. Nulle pour un encaissement en
  -- espèces, qui n'a pas de contrepartie externe.
  reference_externe TEXT,
  lien_paiement   TEXT,
  telephone       TEXT,
  demande_le      TIMESTAMPTZ NOT NULL DEFAULT now(),
  regle_le        TIMESTAMPTZ,
  derniere_erreur TEXT
);

-- Un même paiement ne doit pas être enregistré deux fois pour une facture : le
-- client paierait deux fois.
CREATE UNIQUE INDEX IF NOT EXISTS idx_paiements_reference
  ON paiements (reference_externe) WHERE reference_externe IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paiements_facture ON paiements (facture_id);
CREATE INDEX IF NOT EXISTS idx_paiements_entreprise
  ON paiements (entreprise_id, statut, demande_le DESC);

-- État de règlement porté par la facture : c'est ce que lit la caisse, et il ne
-- doit pas exiger une agrégation des paiements à chaque affichage.
ALTER TABLE factures ADD COLUMN IF NOT EXISTS montant_regle BIGINT NOT NULL DEFAULT 0;
ALTER TABLE factures ADD COLUMN IF NOT EXISTS reglee_le TIMESTAMPTZ;

/* ------------------------------------------------------------------ */
/* Attestation de Régularité Fiscale                                   */
/* ------------------------------------------------------------------ */

-- Le cahier des charges demande un tableau de bord affichant en permanence si
-- l'entreprise est en règle, avec une alerte AVANT la rupture — parce qu'une ARF
-- expirée bloque l'accès aux marchés publics, et qu'on le découvre en général
-- au moment de répondre à un appel d'offres.
CREATE TABLE IF NOT EXISTS attestations_arf (
  id             UUID PRIMARY KEY,
  entreprise_id  UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  numero         TEXT,
  delivree_le    DATE NOT NULL,
  expire_le      DATE NOT NULL,
  -- Renseigné quand l'administration retire l'attestation avant son terme.
  revoquee_le    DATE,
  motif_revocation TEXT,
  saisie_le      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expire_le > delivree_le)
);

CREATE INDEX IF NOT EXISTS idx_arf_entreprise
  ON attestations_arf (entreprise_id, expire_le DESC);

/* ------------------------------------------------------------------ */
/* Row Level Security                                                  */
/* ------------------------------------------------------------------ */

DO $$
DECLARE
  nom_table TEXT;
BEGIN
  FOREACH nom_table IN ARRAY ARRAY['paiements','attestations_arf']
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

-- Le webhook de paiement arrive sans session : le prestataire ne connaît que sa
-- propre référence, pas notre entreprise. Il faut donc pouvoir retrouver le
-- paiement concerné avant d'avoir un contexte tenant.
--
-- Même principe que pour le connecteur DGI : une porte étroite, portée par le
-- rôle dédié, qui ne rend que de quoi identifier le paiement — jamais son
-- contenu ni celui de la facture.
GRANT SELECT, UPDATE ON paiements TO fneplus_connecteur;

CREATE OR REPLACE FUNCTION fneplus_paiement_par_reference(p_reference TEXT)
RETURNS TABLE (id UUID, entreprise_id UUID, facture_id UUID, montant BIGINT, statut TEXT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.entreprise_id, p.facture_id, p.montant, p.statut
    FROM paiements p
   WHERE p.reference_externe = p_reference;
$$;

ALTER FUNCTION fneplus_paiement_par_reference(TEXT) OWNER TO fneplus_connecteur;
REVOKE ALL ON FUNCTION fneplus_paiement_par_reference(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_paiement_par_reference(TEXT) TO fneplus_app;
