/**
 * Contenu encodé dans le QR code d'une facture.
 *
 * ⚠️ POINT BLOQUANT N° 1 DU PLAN DE DÉVELOPPEMENT.
 *
 * La structure exacte exigée par la DGI n'est pas confirmée. Deux scénarios
 * changent radicalement le produit :
 *
 *  A. **QR auto-portant** — le QR contient les données de la facture et une
 *     signature vérifiable. Le terminal peut le produire hors ligne, et la
 *     promesse « remise du QR au client sans attendre la connexion » tient.
 *
 *  B. **QR dépendant d'un identifiant DGI** — le QR doit contenir un code
 *     renvoyé par l'administration après transmission. Le terminal ne peut alors
 *     pas le produire hors ligne, et il faut soit négocier des plages
 *     pré-certifiées, soit remettre un QR provisoire remplacé après coup.
 *
 * Ce module est écrit pour que le basculement de A vers B ne touche que lui.
 * Le format est versionné (`FNE1`) : un lecteur saura toujours à quelle
 * spécification un QR ancien répondait, ce qui compte pour une facture archivée
 * dix ans.
 *
 * En attendant la confirmation, on produit un QR auto-portant marqué
 * `provisoire` tant que la DGI n'a pas certifié la facture. L'interface le dit
 * explicitement au commerçant plutôt que de laisser croire à une conformité
 * acquise.
 */

import type { Facture } from '../types.js';

/** Version du format. Incrémentée à chaque évolution de la structure. */
export const VERSION_FORMAT_QR = 'FNE1';

export interface DonneesQR {
  /** Identifiant de format, en tête pour qu'un lecteur sache quoi attendre. */
  format: string;
  /** NCC de l'émetteur. */
  ncc: string;
  numero: string;
  /** Date d'émission, au format ISO 8601. */
  date: string;
  totalHT: number;
  totalTVA: number;
  totalTTC: number;
  /** Empreinte d'intégrité de la facture, tronquée pour tenir dans le QR. */
  empreinte: string;
  /** Identifiant de certification DGI. Absent tant que la facture n'est pas certifiée. */
  certification?: string;
}

export interface ResultatQR {
  contenu: string;
  donnees: DonneesQR;
  /**
   * Vrai tant que la DGI n'a pas certifié la facture.
   *
   * Un QR provisoire prouve l'intégrité de la facture et permet au client de la
   * vérifier plus tard, mais il ne porte pas encore l'identifiant officiel.
   */
  provisoire: boolean;
}

/**
 * Construit le contenu du QR.
 *
 * Séparateur `|` et champs positionnels plutôt que JSON : un QR doit rester
 * petit. Moins de données encodées, c'est une matrice moins dense, donc un code
 * qui se lit du premier coup sur un ticket imprimé en thermique et scanné par un
 * téléphone d'entrée de gamme.
 */
export function construireContenuQR(
  facture: Pick<Facture, 'numero' | 'emiseLe' | 'totaux' | 'hash' | 'identifiantCertificationDGI'>,
  ncc: string,
): ResultatQR {
  const donnees: DonneesQR = {
    format: VERSION_FORMAT_QR,
    ncc,
    numero: facture.numero,
    date: facture.emiseLe,
    totalHT: facture.totaux.totalHT,
    totalTVA: facture.totaux.totalTVA,
    totalTTC: facture.totaux.totalTTC,
    // 16 caractères : assez pour rendre une collision improbable sur le volume
    // d'une entreprise, assez court pour ne pas densifier la matrice.
    empreinte: facture.hash.slice(0, 16),
    ...(facture.identifiantCertificationDGI
      ? { certification: facture.identifiantCertificationDGI }
      : {}),
  };

  const contenu = [
    donnees.format,
    donnees.ncc,
    donnees.numero,
    donnees.date,
    donnees.totalHT,
    donnees.totalTVA,
    donnees.totalTTC,
    donnees.empreinte,
    donnees.certification ?? '',
  ].join('|');

  return { contenu, donnees, provisoire: !donnees.certification };
}

/** Relit un contenu de QR. Utilisé par le portail de vérification. */
export function lireContenuQR(contenu: string): DonneesQR | null {
  const champs = contenu.split('|');
  if (champs.length < 8 || champs[0] !== VERSION_FORMAT_QR) return null;

  const [format, ncc, numero, date, ht, tva, ttc, empreinte, certification] = champs;

  return {
    format: format!,
    ncc: ncc!,
    numero: numero!,
    date: date!,
    totalHT: Number(ht),
    totalTVA: Number(tva),
    totalTTC: Number(ttc),
    empreinte: empreinte!,
    ...(certification ? { certification } : {}),
  };
}
