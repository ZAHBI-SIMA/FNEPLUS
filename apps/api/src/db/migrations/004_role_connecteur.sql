-- Rôle dédié au connecteur DGI.
--
-- Problème constaté en test : le connecteur balaie la file de transmission pour
-- TOUTES les entreprises, donc sans contexte tenant. Les tables portent
-- `FORCE ROW LEVEL SECURITY`, qui s'applique y compris au propriétaire — une
-- fonction `SECURITY DEFINER` appartenant au propriétaire des tables ne
-- contourne donc pas les politiques, et le balayage ne remontait rien.
--
-- Plutôt que d'affaiblir la RLS sur des tables qui contiennent des pièces
-- comptables, on ouvre une porte étroite et explicite : un rôle sans connexion,
-- porteur de BYPASSRLS, qui ne possède QUE les fonctions de balayage de la file
-- et ne reçoit de droits que sur cette table.
--
-- Ce rôle ne peut pas se connecter (NOLOGIN) : il n'existe que comme propriétaire
-- des fonctions ci-dessous. Toute lecture de facture reste soumise à la RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fneplus_connecteur') THEN
    CREATE ROLE fneplus_connecteur NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE fneplus_connecteur BYPASSRLS;
  END IF;
END
$$;

-- Droits strictement limités à la file : le connecteur choisit et fait avancer
-- des transmissions, il ne lit jamais le contenu d'une facture par cette voie.
GRANT SELECT, UPDATE ON file_transmission TO fneplus_connecteur;

ALTER FUNCTION fneplus_file_a_traiter(INTEGER) OWNER TO fneplus_connecteur;
ALTER FUNCTION fneplus_file_reporter(UUID, INTEGER, TIMESTAMPTZ, TEXT) OWNER TO fneplus_connecteur;
ALTER FUNCTION fneplus_file_marquer(UUID, TEXT, TEXT) OWNER TO fneplus_connecteur;
ALTER FUNCTION fneplus_file_etat() OWNER TO fneplus_connecteur;
ALTER FUNCTION fneplus_file_relancer_interventions() OWNER TO fneplus_connecteur;

-- Les droits d'exécution restent réservés au rôle applicatif.
GRANT EXECUTE ON FUNCTION fneplus_file_a_traiter(INTEGER) TO fneplus_app;
GRANT EXECUTE ON FUNCTION fneplus_file_reporter(UUID, INTEGER, TIMESTAMPTZ, TEXT) TO fneplus_app;
GRANT EXECUTE ON FUNCTION fneplus_file_marquer(UUID, TEXT, TEXT) TO fneplus_app;
GRANT EXECUTE ON FUNCTION fneplus_file_etat() TO fneplus_app;
GRANT EXECUTE ON FUNCTION fneplus_file_relancer_interventions() TO fneplus_app;
