-- Résolution d'identité à la connexion.
--
-- Problème : pour connecter un utilisateur, il faut retrouver son compte à
-- partir de son seul numéro de téléphone — donc AVANT de savoir à quelle
-- entreprise il appartient, donc avant de pouvoir poser le contexte tenant dont
-- dépend toute la RLS.
--
-- Plutôt que d'affaiblir les politiques sur `utilisateurs`, on ouvre une porte
-- étroite : une fonction SECURITY DEFINER qui ne rend que le strict nécessaire
-- pour établir la session. Elle ne renvoie ni le PIN, ni les données de
-- l'entreprise, et ne peut pas servir à énumérer les comptes d'un concurrent.

CREATE OR REPLACE FUNCTION fneplus_resoudre_compte(p_telephone TEXT)
RETURNS TABLE (utilisateur_id UUID, entreprise_id UUID, role TEXT, nom TEXT, a_un_pin BOOLEAN)
LANGUAGE SQL
SECURITY DEFINER
-- `search_path` figé : sans cela, un schéma malicieux placé en tête pourrait
-- détourner la résolution des noms dans une fonction qui s'exécute avec les
-- droits du propriétaire.
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.entreprise_id, u.role, u.nom, (u.pin_hash IS NOT NULL)
    FROM utilisateurs u
   WHERE u.telephone = p_telephone
     AND u.desactive_le IS NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION fneplus_resoudre_compte(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_resoudre_compte(TEXT) TO fneplus_app;

-- Même problème pour l'inscription : on doit vérifier qu'un NCC n'est pas déjà
-- pris sans avoir de contexte tenant. On ne renvoie qu'un booléen — jamais le
-- nom de l'entreprise déjà inscrite.
CREATE OR REPLACE FUNCTION fneplus_ncc_existe(p_ncc TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM entreprises WHERE ncc = p_ncc);
$$;

REVOKE ALL ON FUNCTION fneplus_ncc_existe(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_ncc_existe(TEXT) TO fneplus_app;
