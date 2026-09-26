#!/usr/bin/env bash
set -euo pipefail

# Vérifie qu'une sauvegarde se restaure réellement, avec les mêmes données —
# pas seulement qu'elle « s'exécute sans erreur ». Un plan de sauvegarde
# jamais restauré n'est qu'une hypothèse (exigence du Sprint 6 : « testé par
# restauration réelle »).
#
# Restaure dans une base temporaire, séparée de la base de développement : la
# base réelle n'est jamais touchée, seulement lue pour la comparaison.

CONTENEUR="${FNEPLUS_CONTENEUR_PG:-fneplus-postgres}"
BASE="${FNEPLUS_BASE:-fneplus}"
BASE_TEST="${BASE}_restauration_test"
UTILISATEUR="${FNEPLUS_UTILISATEUR_PG:-fneplus}"
DOSSIER="${FNEPLUS_DOSSIER_SAUVEGARDES:-$(cd "$(dirname "$0")" && pwd)/sauvegardes}"

FICHIER="${1:-$(ls -t "$DOSSIER"/*.dump 2>/dev/null | head -1)}"
if [ -z "$FICHIER" ]; then
  echo "Aucune sauvegarde trouvée dans $DOSSIER. Lancez d'abord sauvegarde.sh." >&2
  exit 1
fi

echo "Restauration de $(basename "$FICHIER") dans une base temporaire ($BASE_TEST)…"

docker exec "$CONTENEUR" psql -U "$UTILISATEUR" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ${BASE_TEST};" >/dev/null
docker exec "$CONTENEUR" psql -U "$UTILISATEUR" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${BASE_TEST};" >/dev/null

# --no-owner : la base restaurée appartient à l'utilisateur qui restaure, pas
# aux rôles d'origine — sans quoi une restauration sur un autre serveur, avec
# des rôles différents, échouerait sur des ALTER ... OWNER TO.
docker exec -i "$CONTENEUR" pg_restore -U "$UTILISATEUR" -d "$BASE_TEST" --no-owner < "$FICHIER"

echo ""
echo "Comparaison des effectifs, base réelle vs restaurée :"
ECART=0
for TABLE in entreprises factures paiements attestations_arf clients produits; do
  N_SOURCE=$(docker exec "$CONTENEUR" psql -U "$UTILISATEUR" -d "$BASE" -tAc "SELECT COUNT(*) FROM ${TABLE}")
  N_RESTAUREE=$(docker exec "$CONTENEUR" psql -U "$UTILISATEUR" -d "$BASE_TEST" -tAc "SELECT COUNT(*) FROM ${TABLE}")
  if [ "$N_SOURCE" = "$N_RESTAUREE" ]; then
    STATUT="OK"
  else
    STATUT="ÉCART"
    ECART=1
  fi
  printf '  %-20s %8s -> %8s  %s\n' "$TABLE" "$N_SOURCE" "$N_RESTAUREE" "$STATUT"
done

docker exec "$CONTENEUR" psql -U "$UTILISATEUR" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE ${BASE_TEST};" >/dev/null

if [ "$ECART" -eq 0 ]; then
  echo ""
  echo "Restauration vérifiée : toutes les tables correspondent."
  exit 0
else
  echo ""
  echo "ÉCHEC : au moins une table ne correspond pas après restauration." >&2
  exit 1
fi
