-- Multi-boutiques avec droits différenciés (V2, chantier « élargissement des
-- comptes »).
--
-- L'inscription créait déjà un point de vente unique, modifiable ensuite —
-- mais rien ne permettait d'en ajouter un second. Le schéma des factures et
-- des terminaux, lui, portait déjà `point_de_vente_id` depuis le socle : ce
-- n'est pas une nouvelle notion, seulement la première boutique qui en
-- gagne une deuxième.
--
-- Droits différenciés : un utilisateur rattaché à une boutique précise
-- (`point_de_vente_id` non nul) ne voit que celle-ci dans les vues
-- consolidées ; laissé à NULL (comportement par défaut, y compris pour tout
-- utilisateur existant), il voit l'ensemble — c'est le cas normal d'un
-- propriétaire ou d'un comptable, qui doivent voir toutes les boutiques.

ALTER TABLE utilisateurs
  ADD COLUMN IF NOT EXISTS point_de_vente_id UUID REFERENCES points_de_vente(id);

-- `fneplus_resoudre_compte` doit maintenant renvoyer cette colonne pour que la
-- session en tienne compte. Le type de retour change : DROP puis CREATE,
-- CREATE OR REPLACE seul refuse de modifier la liste des colonnes.
DROP FUNCTION IF EXISTS fneplus_resoudre_compte(TEXT);

CREATE FUNCTION fneplus_resoudre_compte(p_telephone TEXT)
RETURNS TABLE (
  utilisateur_id UUID, entreprise_id UUID, role TEXT, nom TEXT,
  a_un_pin BOOLEAN, point_de_vente_id UUID
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.entreprise_id, u.role, u.nom, (u.pin_hash IS NOT NULL), u.point_de_vente_id
    FROM utilisateurs u
   WHERE u.telephone = p_telephone
     AND u.desactive_le IS NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION fneplus_resoudre_compte(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_resoudre_compte(TEXT) TO fneplus_app;
