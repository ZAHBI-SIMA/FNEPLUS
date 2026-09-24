/**
 * Chaîne d'intégrité des factures.
 *
 * Chaque facture porte le hash de la précédente pour la même entreprise. Une
 * facture supprimée ou modifiée a posteriori casse la chaîne de façon détectable :
 * c'est ce qui rend l'archivage « infalsifiable » au sens du cahier des charges,
 * et ce que le portail agent DGI doit pouvoir rejouer lors d'un contrôle.
 *
 * Implémentation volontairement isomorphe (Web Crypto) : le terminal calcule le
 * hash au moment de l'émission, hors ligne ; le serveur le revérifie à la
 * réception sans avoir besoin de refaire confiance au terminal.
 */

import type { Facture } from '../types.js';

/** Hash conventionnel de la première facture d'une entreprise (racine de chaîne). */
export const HASH_GENESE = '0'.repeat(64);

/**
 * Sérialisation canonique : clés triées récursivement, pas d'espaces.
 * Deux exécutions sur deux plateformes doivent produire exactement la même
 * chaîne, sans quoi les hashs divergent entre le terminal et le serveur.
 */
export function canoniser(valeur: unknown): string {
  if (valeur === null || typeof valeur !== 'object') {
    return JSON.stringify(valeur ?? null);
  }
  if (Array.isArray(valeur)) {
    return `[${valeur.map(canoniser).join(',')}]`;
  }
  const entrees = Object.entries(valeur as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entrees.map(([k, v]) => `${JSON.stringify(k)}:${canoniser(v)}`).join(',')}}`;
}

async function sha256Hex(contenu: string): Promise<string> {
  const donnees = new TextEncoder().encode(contenu);
  const empreinte = await globalThis.crypto.subtle.digest('SHA-256', donnees);
  return [...new Uint8Array(empreinte)].map((o) => o.toString(16).padStart(2, '0')).join('');
}

/**
 * Champs entrant dans le hash.
 *
 * Volontairement restreint à ce qui est opposable au client et à
 * l'administration : le statut de transmission, l'identifiant de certification
 * et le motif de rejet en sont EXCLUS, car ils évoluent après émission alors que
 * le hash doit rester stable.
 */
export interface EmpreinteFacture {
  entrepriseId: string;
  numero: string;
  type: string;
  emiseLe: string;
  clientNom: string;
  clientNcc?: string;
  lignes: {
    designation: string;
    quantite: number;
    prixUnitaireHT: number;
    codeTva: string;
    remisePourcent: number;
  }[];
  totalHT: number;
  totalTVA: number;
  totalTTC: number;
  versionReferentielFiscal: string;
  hashPrecedent: string;
}

export function extraireEmpreinte(
  facture: Omit<Facture, 'hash' | 'id' | 'statut'>,
): EmpreinteFacture {
  return {
    entrepriseId: facture.entrepriseId,
    numero: facture.numero,
    type: facture.type,
    emiseLe: facture.emiseLe,
    clientNom: facture.clientNom,
    clientNcc: facture.clientNcc,
    lignes: facture.lignes.map((l) => ({
      designation: l.designation,
      quantite: l.quantite,
      prixUnitaireHT: l.prixUnitaireHT,
      codeTva: l.codeTva,
      remisePourcent: l.remisePourcent ?? 0,
    })),
    totalHT: facture.totaux.totalHT,
    totalTVA: facture.totaux.totalTVA,
    totalTTC: facture.totaux.totalTTC,
    versionReferentielFiscal: facture.versionReferentielFiscal,
    hashPrecedent: facture.hashPrecedent,
  };
}

export async function calculerHash(
  facture: Omit<Facture, 'hash' | 'id' | 'statut'>,
): Promise<string> {
  return sha256Hex(canoniser(extraireEmpreinte(facture)));
}

export interface ResultatVerification {
  valide: boolean;
  anomalies: {
    index: number;
    numero: string;
    type: 'HASH_INVALIDE' | 'CHAINAGE_ROMPU';
    detail: string;
  }[];
}

/**
 * Rejoue une chaîne complète de factures, dans l'ordre d'émission.
 * C'est la primitive derrière l'export de contrôle fiscal.
 */
export async function verifierChaine(factures: readonly Facture[]): Promise<ResultatVerification> {
  const anomalies: ResultatVerification['anomalies'] = [];
  let attendu = HASH_GENESE;

  for (const [index, facture] of factures.entries()) {
    if (facture.hashPrecedent !== attendu) {
      anomalies.push({
        index,
        numero: facture.numero,
        type: 'CHAINAGE_ROMPU',
        detail: `hashPrecedent attendu ${attendu}, trouvé ${facture.hashPrecedent}`,
      });
    }

    const recalcule = await calculerHash(facture);
    if (recalcule !== facture.hash) {
      anomalies.push({
        index,
        numero: facture.numero,
        type: 'HASH_INVALIDE',
        detail: `hash attendu ${recalcule}, trouvé ${facture.hash}`,
      });
    }

    attendu = facture.hash;
  }

  return { valide: anomalies.length === 0, anomalies };
}
