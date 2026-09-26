-- Indicateurs de succès (chapitre 10 du cahier des charges) : adoption,
-- rétention, usage, conformité.
--
-- Deux échelles bien distinctes :
--  - Par entreprise (usage, conformité) : lu avec le contexte tenant normal,
--    RLS comprise, exactement comme n'importe quelle autre donnée d'un compte.
--    Aucune fonction dédiée n'est nécessaire ici.
--  - Plateforme (adoption, rétention, usage et conformité agrégés) : n'a de
--    sens qu'à travers TOUTES les entreprises, donc sans contexte tenant.
--    Même problème que la file de transmission ([[D-013]]) : une fonction
--    SECURITY DEFINER appartenant au propriétaire des tables ne contourne pas
--    `FORCE ROW LEVEL SECURITY`. On réutilise donc le rôle `fneplus_connecteur`
--    (BYPASSRLS, sans connexion possible) déjà introduit pour ce même besoin,
--    plutôt que d'affaiblir la RLS ou d'inventer un deuxième mécanisme.
--
-- Un seul aller-retour SQL plutôt que plusieurs petites fonctions : le tableau
-- de bord d'exploitation lit un instantané cohérent, pas cinq requêtes prises
-- à des microsecondes différentes.

CREATE OR REPLACE FUNCTION fneplus_kpis_plateforme(
  p_periode_jours INTEGER DEFAULT 30,
  p_delai_reglementaire_heures INTEGER DEFAULT 24
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  bornes AS (
    SELECT
      now() - (p_periode_jours || ' days')::interval AS depuis,
      date_trunc('month', now()) AS debut_mois_courant,
      date_trunc('month', now() - interval '1 month') AS debut_mois_precedent
  ),
  cohorte_six_mois AS (
    SELECT id FROM entreprises WHERE cree_le <= now() - interval '6 months'
  ),
  actifs_six_mois AS (
    SELECT DISTINCT f.entreprise_id
      FROM factures f
     WHERE f.entreprise_id IN (SELECT id FROM cohorte_six_mois)
       AND f.emise_le >= now() - interval '30 days'
  ),
  actifs_mois_courant AS (
    SELECT DISTINCT entreprise_id FROM factures, bornes WHERE emise_le >= debut_mois_courant
  ),
  actifs_mois_precedent AS (
    SELECT DISTINCT entreprise_id FROM factures, bornes
     WHERE emise_le >= debut_mois_precedent AND emise_le < debut_mois_courant
  ),
  entreprises_ayant_emis AS (
    SELECT DISTINCT entreprise_id FROM factures
  ),
  usage_periode AS (
    SELECT
      COUNT(*) AS nombre_factures,
      COUNT(*) FILTER (WHERE recue_le - emise_le > interval '10 seconds') AS nombre_hors_ligne,
      AVG(EXTRACT(EPOCH FROM (recue_le - emise_le))) AS delai_moyen_secondes
      FROM factures, bornes
     WHERE emise_le >= depuis
  ),
  -- Le délai réglementaire se mesure jusqu'à la fin réelle de la transmission
  -- (`terminee_le`), pas jusqu'à la réception serveur : c'est le moment où la
  -- DGI a effectivement statué qui compte pour la conformité.
  conformite_periode AS (
    SELECT
      COUNT(*) FILTER (WHERE ft.etat = 'CERTIFIEE') AS nombre_certifiees,
      COUNT(*) FILTER (
        WHERE ft.etat = 'CERTIFIEE'
          AND ft.terminee_le - f.emise_le <= (p_delai_reglementaire_heures || ' hours')::interval
      ) AS nombre_dans_delai
      FROM factures f
      LEFT JOIN file_transmission ft ON ft.facture_id = f.id
      CROSS JOIN bornes
     WHERE f.emise_le >= bornes.depuis
  ),
  arf AS (
    SELECT
      COUNT(*) AS total_avec_attestation,
      COUNT(*) FILTER (WHERE revoquee_le IS NULL AND expire_le >= now()) AS a_jour
      FROM (
        SELECT DISTINCT ON (entreprise_id) entreprise_id, expire_le, revoquee_le
          FROM attestations_arf
         ORDER BY entreprise_id, expire_le DESC
      ) derniere
  )
  SELECT jsonb_build_object(
    'genereLe', now(),
    'periodeJours', p_periode_jours,
    'delaiReglementaireHeures', p_delai_reglementaire_heures,
    'adoption', jsonb_build_object(
      'entreprisesInscritesTotal', (SELECT COUNT(*) FROM entreprises),
      'entreprisesNouvellesCeMois',
        (SELECT COUNT(*) FROM entreprises, bornes WHERE cree_le >= debut_mois_courant),
      'entreprisesActivesCeMois', (SELECT COUNT(*) FROM actifs_mois_courant),
      'entreprisesAyantEmisTotal', (SELECT COUNT(*) FROM entreprises_ayant_emis)
    ),
    'retention', jsonb_build_object(
      'tailleCohorteSixMois', (SELECT COUNT(*) FROM cohorte_six_mois),
      'encoreActifsApresSixMois', (SELECT COUNT(*) FROM actifs_six_mois),
      'actifsMoisPrecedent', (SELECT COUNT(*) FROM actifs_mois_precedent),
      'actifsMoisCourant', (SELECT COUNT(*) FROM actifs_mois_courant)
    ),
    'usage', jsonb_build_object(
      'nombreFactures', (SELECT nombre_factures FROM usage_periode),
      'nombreHorsLigne', (SELECT nombre_hors_ligne FROM usage_periode),
      'delaiMoyenSyncSecondes', (SELECT delai_moyen_secondes FROM usage_periode)
    ),
    'conformite', jsonb_build_object(
      'nombreCertifiees', (SELECT nombre_certifiees FROM conformite_periode),
      'nombreDansLeDelai', (SELECT nombre_dans_delai FROM conformite_periode),
      'entreprisesAvecAttestation', (SELECT total_avec_attestation FROM arf),
      'entreprisesArfAJour', (SELECT a_jour FROM arf)
    )
  );
$$;

GRANT SELECT ON entreprises, factures, file_transmission, attestations_arf TO fneplus_connecteur;

ALTER FUNCTION fneplus_kpis_plateforme(INTEGER, INTEGER) OWNER TO fneplus_connecteur;
GRANT EXECUTE ON FUNCTION fneplus_kpis_plateforme(INTEGER, INTEGER) TO fneplus_app;
