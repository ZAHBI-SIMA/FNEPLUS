#!/usr/bin/env bash
set -euo pipefail

# Sauvegarde de la base PostgreSQL.
#
# Format personnalisé (-Fc) : compressé, et le seul format qui permette une
# restauration sélective (table par table) en cas de besoin. Une sauvegarde
# qui n'a jamais été restaurée n'est qu'une hypothèse — voir
# `tester-restauration.sh`, qui vérifie celle-ci réellement plutôt que de
# supposer qu'elle fonctionne.

CONTENEUR="${FNEPLUS_CONTENEUR_PG:-fneplus-postgres}"
BASE="${FNEPLUS_BASE:-fneplus}"
UTILISATEUR="${FNEPLUS_UTILISATEUR_PG:-fneplus}"
DOSSIER="${FNEPLUS_DOSSIER_SAUVEGARDES:-$(cd "$(dirname "$0")" && pwd)/sauvegardes}"

mkdir -p "$DOSSIER"
HORODATAGE="$(date +%Y%m%d-%H%M%S)"
FICHIER="$DOSSIER/fneplus-$HORODATAGE.dump"

echo "Sauvegarde de la base « $BASE » (conteneur $CONTENEUR) vers $FICHIER…"
docker exec "$CONTENEUR" pg_dump -U "$UTILISATEUR" -d "$BASE" -Fc > "$FICHIER"

TAILLE=$(du -h "$FICHIER" | cut -f1)
echo "Sauvegarde terminée : $FICHIER ($TAILLE)"
