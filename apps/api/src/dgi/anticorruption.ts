/**
 * Couche d'anticorruption entre le modèle FNE+ et le schéma de la DGI.
 *
 * ⚠️ Le schéma exact attendu par `fne.dgi.gouv.ci` n'est pas confirmé
 * (point bloquant n° 2 du plan de développement). Ce module est écrit pour que
 * cette incertitude reste ici et nulle part ailleurs : aucun autre fichier du
 * produit ne connaît la forme des messages de l'administration.
 *
 * Deux principes :
 *
 *  1. **Le modèle interne ne se plie pas au schéma externe.** Une facture FNE+
 *     garde sa structure même si la DGI attend des noms de champs différents,
 *     des dates dans un autre format, ou des montants en centimes. Sans cette
 *     séparation, chaque évolution de l'API publique se propagerait jusque dans
 *     la base locale des terminaux déjà déployés.
 *
 *  2. **Le mapping est versionné.** Une facture transmise en 2026 l'a été selon
 *     une version précise du mapping. Lors d'un contrôle trois ans plus tard, il
 *     faut pouvoir dire quelle transformation a été appliquée — sinon un écart
 *     entre l'archive et ce qu'a reçu la DGI devient inexplicable.
 */

import type { Facture, LigneFacture } from '@fneplus/core';

/** Version du mapping. Tracée sur chaque transmission. */
export const VERSION_MAPPING = '2026.01';

/* ------------------------------------------------------------------ */
/* Schéma sortant — ce que nous envoyons à la DGI                      */
/* ------------------------------------------------------------------ */

export interface FactureDGI {
  /** Identifiant unique côté émetteur, sert de clé d'idempotence. */
  id: string;
  entrepriseId: string;
  ncc: string;
  numero: string;
  typeDocument: string;
  dateEmission: string;
  client: {
    nom: string;
    ncc?: string;
  };
  lignes: {
    designation: string;
    quantite: number;
    prixUnitaireHT: number;
    codeTaxation: string;
    tauxTVA: number;
    montantHT: number;
    montantTVA: number;
  }[];
  totaux: {
    totalHT: number;
    totalTVA: number;
    totalTTC: number;
    ventilation: { taux: number; baseHT: number; montantTVA: number }[];
  };
  /** Empreinte d'intégrité, pour que la DGI puisse détecter une altération. */
  empreinte: string;
  empreintePrecedente: string;
  versionReferentielFiscal: string;
  versionMapping: string;
}

/* ------------------------------------------------------------------ */
/* Schéma entrant — ce que la DGI nous répond                          */
/* ------------------------------------------------------------------ */

export type StatutDGI = 'CERTIFIEE' | 'REJETEE';

export interface ReponseDGI {
  statut: StatutDGI;
  identifiantCertification?: string;
  horodatageCertifie?: string;
  contenuQR?: string;
  motifs?: string[];
}

/** Réponse traduite en termes FNE+, prête à être appliquée à une facture. */
export interface ResultatTransmission {
  certifiee: boolean;
  identifiantCertification?: string;
  horodatageCertifie?: string;
  contenuQR?: string;
  /** Message destiné au commerçant, en français clair. */
  messageUtilisateur?: string;
  /** Vrai si un nouvel essai est inutile : la facture doit être corrigée. */
  definitif: boolean;
}

/* ------------------------------------------------------------------ */
/* Traduction sortante                                                 */
/* ------------------------------------------------------------------ */

export function versFactureDGI(
  facture: Facture,
  lignes: LigneFacture[],
  ncc: string,
  tauxParCode: (code: string) => number,
): FactureDGI {
  return {
    id: facture.id,
    entrepriseId: facture.entrepriseId,
    ncc,
    numero: facture.numero,
    typeDocument: facture.type,
    dateEmission: facture.emiseLe,
    client: {
      nom: facture.clientNom,
      ...(facture.clientNcc ? { ncc: facture.clientNcc } : {}),
    },
    lignes: lignes.map((ligne) => {
      const taux = tauxParCode(ligne.codeTva);
      const brut = Math.round(ligne.quantite * ligne.prixUnitaireHT);
      const remise = Math.round((brut * (ligne.remisePourcent ?? 0)) / 100);
      const montantHT = brut - remise;
      return {
        designation: ligne.designation,
        quantite: ligne.quantite,
        prixUnitaireHT: ligne.prixUnitaireHT,
        codeTaxation: ligne.codeTva,
        tauxTVA: taux,
        montantHT,
        montantTVA: Math.round((montantHT * taux) / 100),
      };
    }),
    totaux: {
      totalHT: facture.totaux.totalHT,
      totalTVA: facture.totaux.totalTVA,
      totalTTC: facture.totaux.totalTTC,
      ventilation: facture.totaux.ventilation.map((v) => ({
        taux: v.taux,
        baseHT: v.baseHT,
        montantTVA: v.montantTVA,
      })),
    },
    empreinte: facture.hash,
    empreintePrecedente: facture.hashPrecedent,
    versionReferentielFiscal: facture.versionReferentielFiscal,
    versionMapping: VERSION_MAPPING,
  };
}

/* ------------------------------------------------------------------ */
/* Traduction entrante                                                 */
/* ------------------------------------------------------------------ */

/**
 * Motifs de rejet connus, traduits en langage utilisateur.
 *
 * Un code d'erreur brut affiché à un commerçant ne l'aide pas à corriger. Tant
 * que la liste officielle n'est pas publiée, on traduit ce qu'on reconnaît et on
 * laisse passer le reste tel quel plutôt que d'inventer un message générique qui
 * masquerait l'information utile.
 */
const TRADUCTIONS: { motif: RegExp; message: string; definitif: boolean }[] = [
  {
    motif: /num[ée]ro.*d[ée]j[àa]|d[ée]j[àa].*transmis|duplicate/i,
    message:
      'Ce numéro de facture a déjà été transmis à la DGI. Vérifiez la réserve de numéros de ce terminal.',
    definitif: true,
  },
  {
    motif: /ncc|contribuable.*(inconnu|invalide)/i,
    message:
      'Le numéro de compte contribuable est refusé par la DGI. Vérifiez-le dans les paramètres de votre entreprise.',
    definitif: true,
  },
  {
    motif: /montant|total|calcul/i,
    message:
      'La DGI a refusé les montants de cette facture. Elle a été mise de côté pour vérification.',
    definitif: true,
  },
  {
    motif: /aucune ligne|ligne.*vide/i,
    message: 'Cette facture ne comporte aucune ligne exploitable.',
    definitif: true,
  },
  {
    motif: /indisponible|maintenance|timeout|temporair/i,
    message:
      'Le service de la DGI est momentanément indisponible. L’envoi sera automatiquement repris.',
    definitif: false,
  },
];

export function depuisReponseDGI(reponse: ReponseDGI): ResultatTransmission {
  if (reponse.statut === 'CERTIFIEE') {
    return {
      certifiee: true,
      ...(reponse.identifiantCertification
        ? { identifiantCertification: reponse.identifiantCertification }
        : {}),
      ...(reponse.horodatageCertifie ? { horodatageCertifie: reponse.horodatageCertifie } : {}),
      ...(reponse.contenuQR ? { contenuQR: reponse.contenuQR } : {}),
      definitif: false,
    };
  }

  const motifs = reponse.motifs ?? [];
  const brut = motifs.join(' ; ');

  for (const traduction of TRADUCTIONS) {
    if (traduction.motif.test(brut)) {
      return {
        certifiee: false,
        messageUtilisateur: traduction.message,
        definitif: traduction.definitif,
      };
    }
  }

  // Motif non reconnu : on le transmet tel quel. Mieux vaut un message brut
  // exploitable par le support qu'un « erreur inconnue » qui perd l'information.
  return {
    certifiee: false,
    messageUtilisateur:
      brut.length > 0
        ? `La DGI a refusé cette facture : ${brut}`
        : 'La DGI a refusé cette facture sans préciser de motif.',
    definitif: true,
  };
}
