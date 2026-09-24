/**
 * Référentiel fiscal versionné.
 *
 * Exigence du cahier des charges : « mise à jour des taux et seuils sans
 * intervention du client » et « veille et mise à jour automatique des paramètres
 * FNE dans un délai contractuel court ».
 *
 * Conséquence de conception : aucun taux n'est écrit en dur dans le code de
 * calcul. Une version du référentiel porte une date d'effet ; le moteur résout
 * les taux applicables à la DATE D'ÉMISSION de la facture, jamais à la date du
 * jour. Une facture rectificative émise en 2027 pour une facture de 2026
 * recalcule donc avec le référentiel de 2026.
 *
 * Les versions sont livrées par l'API et mises en cache localement, ce qui permet
 * au terminal de calculer correctement hors ligne.
 *
 * ⚠️ Les valeurs ci-dessous sont des valeurs d'amorçage à CONFIRMER auprès de la
 * DGI avant toute mise en production (cf. docs/PLAN-DEVELOPPEMENT.md §1).
 */

import type { CodeTVA, RegimeFiscal } from '../types.js';

export interface TauxTVA {
  code: CodeTVA;
  /** Taux en points de pourcentage. */
  taux: number;
  libelle: string;
}

export interface SeuilRegime {
  regime: RegimeFiscal;
  /** Chiffre d'affaires annuel minimum (inclus), en francs CFA. */
  caMin: number;
  /** Chiffre d'affaires annuel maximum (inclus), en francs CFA. `null` = pas de plafond. */
  caMax: number | null;
  /** Le régime collecte-t-il la TVA ? */
  assujettiTVA: boolean;
}

export interface VersionReferentielFiscal {
  /** Identifiant de version, tracé sur chaque facture. */
  version: string;
  /** Date d'entrée en vigueur (ISO 8601, date seule). */
  dateEffet: string;
  /** Date de fin d'application. `null` = version courante. */
  dateFin: string | null;
  source: string;
  tauxTVA: TauxTVA[];
  seuils: SeuilRegime[];
}

export const REFERENTIEL_2026_01: VersionReferentielFiscal = {
  version: '2026.01',
  dateEffet: '2026-01-01',
  dateFin: null,
  source: 'Valeurs d’amorçage — à confirmer auprès de la DGI (annexe fiscale en vigueur)',
  tauxTVA: [
    { code: 'TVA_NORMAL', taux: 18, libelle: 'TVA taux normal' },
    { code: 'TVA_REDUIT', taux: 9, libelle: 'TVA taux réduit' },
    { code: 'EXONERE', taux: 0, libelle: 'Exonéré de TVA' },
    { code: 'HORS_CHAMP', taux: 0, libelle: 'Hors champ d’application de la TVA' },
  ],
  seuils: [
    { regime: 'ENTREPRENANT', caMin: 0, caMax: 50_000_000, assujettiTVA: false },
    { regime: 'MICROENTREPRISE', caMin: 50_000_001, caMax: 200_000_000, assujettiTVA: false },
    { regime: 'REEL_SIMPLIFIE', caMin: 200_000_001, caMax: 500_000_000, assujettiTVA: true },
    { regime: 'REEL_NORMAL', caMin: 500_000_001, caMax: null, assujettiTVA: true },
  ],
};

/** Versions embarquées par défaut. L'API peut en pousser de nouvelles à chaud. */
export const REFERENTIELS_EMBARQUES: VersionReferentielFiscal[] = [REFERENTIEL_2026_01];

export class ErreurReferentiel extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurReferentiel';
  }
}

/**
 * Résout la version du référentiel applicable à une date donnée.
 * @param dateEmission date d'émission de la facture (ISO 8601)
 */
export function resoudreReferentiel(
  dateEmission: string,
  versions: readonly VersionReferentielFiscal[] = REFERENTIELS_EMBARQUES,
): VersionReferentielFiscal {
  const jour = dateEmission.slice(0, 10);
  const candidates = versions
    .filter((v) => v.dateEffet <= jour && (v.dateFin === null || v.dateFin >= jour))
    .sort((a, b) => (a.dateEffet < b.dateEffet ? 1 : -1));

  const trouvee = candidates[0];
  if (!trouvee) {
    throw new ErreurReferentiel(
      `Aucun référentiel fiscal applicable au ${jour}. Synchronisez le terminal pour récupérer la version en vigueur.`,
    );
  }
  return trouvee;
}

export function tauxPourCode(referentiel: VersionReferentielFiscal, code: CodeTVA): number {
  const entree = referentiel.tauxTVA.find((t) => t.code === code);
  if (!entree) {
    throw new ErreurReferentiel(
      `Code de taxation « ${code} » absent du référentiel ${referentiel.version}`,
    );
  }
  return entree.taux;
}

export function estAssujettiTVA(
  referentiel: VersionReferentielFiscal,
  regime: RegimeFiscal,
): boolean {
  const seuil = referentiel.seuils.find((s) => s.regime === regime);
  if (!seuil) {
    throw new ErreurReferentiel(
      `Régime « ${regime} » absent du référentiel ${referentiel.version}`,
    );
  }
  return seuil.assujettiTVA;
}

/** Régime théoriquement applicable pour un chiffre d'affaires annuel donné. */
export function regimePourChiffreAffaires(
  referentiel: VersionReferentielFiscal,
  caAnnuel: number,
): RegimeFiscal {
  const seuil = referentiel.seuils.find(
    (s) => caAnnuel >= s.caMin && (s.caMax === null || caAnnuel <= s.caMax),
  );
  if (!seuil) {
    throw new ErreurReferentiel(`Aucun régime ne couvre un chiffre d’affaires de ${caAnnuel}`);
  }
  return seuil.regime;
}
