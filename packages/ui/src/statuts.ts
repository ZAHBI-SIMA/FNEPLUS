import type { TonBadge } from './composants/Badge';

/**
 * Traduction du cycle de vie d'une facture en langage utilisateur.
 *
 * Les libellés évitent le vocabulaire technique : le commerçant lit « Gardée sur
 * l'appareil », pas « EMISE_LOCALEMENT ». Le statut de rejet dit toujours ce
 * qu'il faut faire, jamais seulement ce qui a échoué.
 */
const CATALOGUE: Record<string, { libelle: string; ton: TonBadge }> = {
  BROUILLON: { libelle: 'Brouillon', ton: 'neutre' },
  EMISE_LOCALEMENT: { libelle: 'Gardée sur l’appareil', ton: 'attente' },
  EN_FILE_DGI: { libelle: 'En cours d’envoi à la DGI', ton: 'info' },
  TRANSMISE: { libelle: 'Reçue par la DGI', ton: 'info' },
  CERTIFIEE: { libelle: 'Certifiée', ton: 'succes' },
  REJETEE: { libelle: 'À corriger', ton: 'erreur' },
};

export function libelleStatutFacture(statut: string): string {
  return CATALOGUE[statut]?.libelle ?? statut;
}

export function tonPourStatutFacture(statut: string): TonBadge {
  return CATALOGUE[statut]?.ton ?? 'neutre';
}
