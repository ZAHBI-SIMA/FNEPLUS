-- Établissements (V2, chantier « élargissement des comptes »).
--
-- Un établissement est un site physique déclaré à l'administration fiscale ;
-- un point de vente est une caisse, un comptoir ou un canal (e-commerce) à
-- l'intérieur de cet établissement. Le multi-boutiques (migration 007) a déjà
-- donné aux points de vente des droits différenciés ; l'établissement est un
-- niveau au-dessus, pour les entreprises ayant plusieurs sites.
--
-- Chaque entreprise existante n'a jusqu'ici connu qu'un seul niveau : on lui
-- crée donc un « Établissement principal » de repli, auquel tous ses points
-- de vente actuels sont rattachés — aucune entreprise ne se retrouve avec un
-- point de vente orphelin après cette migration.

CREATE TABLE IF NOT EXISTS etablissements (
  id            UUID PRIMARY KEY,
  entreprise_id UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  libelle       TEXT NOT NULL,
  code          TEXT NOT NULL,
  adresse       TEXT,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entreprise_id, code)
);

ALTER TABLE points_de_vente
  ADD COLUMN IF NOT EXISTS etablissement_id UUID REFERENCES etablissements(id);

-- Deuxième tier de droits différenciés, au niveau du site cette fois : un
-- utilisateur rattaché à un établissement (non nul) ne voit que les points de
-- vente de celui-ci dans les vues consolidées ; laissé à NULL (comportement
-- par défaut), il voit l'ensemble — même logique que point_de_vente_id
-- (migration 007), un cran au-dessus.
ALTER TABLE utilisateurs
  ADD COLUMN IF NOT EXISTS etablissement_id UUID REFERENCES etablissements(id);

-- Un terminal reste lié à UN point de vente « principal » (terminaux.point_de_vente_id,
-- socle) : c'est lui qui a servi à l'appairage et qui continue de porter le
-- comportement par défaut, inchangé. Cette table n'ajoute qu'une autorisation
-- SUPPLÉMENTAIRE, explicitement accordée par le propriétaire, pour qu'un même
-- appareil puisse aussi facturer au nom d'un autre point de vente (sélecteur
-- rapide en caisse) — chaque point de vente autorisé obtient sa propre plage
-- de numéros, allouée séparément, donc sans risque pour la séquence du point
-- de vente principal.
CREATE TABLE IF NOT EXISTS terminaux_points_de_vente (
  entreprise_id     UUID NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  terminal_id       UUID NOT NULL REFERENCES terminaux(id) ON DELETE CASCADE,
  point_de_vente_id UUID NOT NULL REFERENCES points_de_vente(id) ON DELETE CASCADE,
  autorise_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (terminal_id, point_de_vente_id)
);

CREATE INDEX IF NOT EXISTS idx_tpdv_terminal ON terminaux_points_de_vente (terminal_id);

-- Établissement de repli, un par entreprise ayant déjà au moins un point de
-- vente, puis rattachement de tous ses points de vente à ce jour.
INSERT INTO etablissements (id, entreprise_id, libelle, code)
SELECT gen_random_uuid(), e.id, 'Établissement principal', 'ETB01'
  FROM entreprises e
 WHERE EXISTS (SELECT 1 FROM points_de_vente pdv WHERE pdv.entreprise_id = e.id)
ON CONFLICT (entreprise_id, code) DO NOTHING;

UPDATE points_de_vente pdv
   SET etablissement_id = et.id
  FROM etablissements et
 WHERE et.entreprise_id = pdv.entreprise_id
   AND pdv.etablissement_id IS NULL;

-- `fneplus_resoudre_compte` doit renvoyer ce nouveau tier de droits différenciés
-- pour que la session en tienne compte. DROP puis CREATE : CREATE OR REPLACE
-- seul refuse de modifier la liste des colonnes renvoyées.
DROP FUNCTION IF EXISTS fneplus_resoudre_compte(TEXT);

CREATE FUNCTION fneplus_resoudre_compte(p_telephone TEXT)
RETURNS TABLE (
  utilisateur_id UUID, entreprise_id UUID, role TEXT, nom TEXT,
  a_un_pin BOOLEAN, point_de_vente_id UUID, etablissement_id UUID
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.entreprise_id, u.role, u.nom, (u.pin_hash IS NOT NULL),
         u.point_de_vente_id, u.etablissement_id
    FROM utilisateurs u
   WHERE u.telephone = p_telephone
     AND u.desactive_le IS NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION fneplus_resoudre_compte(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fneplus_resoudre_compte(TEXT) TO fneplus_app;

-- Row Level Security sur les deux nouvelles tables, même politique que le
-- reste du socle (migration 001) : isolation stricte par entreprise_id.
DO $$
DECLARE
  nom_table TEXT;
BEGIN
  FOREACH nom_table IN ARRAY ARRAY['etablissements', 'terminaux_points_de_vente']
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
