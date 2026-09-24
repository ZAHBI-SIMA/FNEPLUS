/**
 * Moteur de calcul fiscal.
 *
 * Ce module est le seul endroit du produit où se calcule une TVA. Il tourne à
 * l'identique dans le navigateur (facture émise hors ligne) et sur le serveur
 * (revalidation à la réception). Le serveur recalcule systématiquement et
 * compare : un écart signifie terminal compromis ou référentiel désynchronisé,
 * et la facture part en revue plutôt qu'en transmission silencieuse.
 */

import { appliquerTaux, arrondirFranc, somme, type MontantXOF } from '../money.js';
import type {
  CodeTVA,
  LigneCalculee,
  LigneFacture,
  RegimeFiscal,
  TotauxFacture,
  VentilationTVA,
} from '../types.js';
import {
  estAssujettiTVA,
  resoudreReferentiel,
  tauxPourCode,
  type VersionReferentielFiscal,
} from './referentiel.js';

export interface ContexteCalcul {
  /** Date d'émission (ISO 8601) : détermine la version du référentiel appliquée. */
  dateEmission: string;
  regimeFiscal: RegimeFiscal;
  /** Versions disponibles. Par défaut, celles embarquées dans le bundle. */
  versionsReferentiel?: readonly VersionReferentielFiscal[];
}

export interface ResultatCalcul {
  lignes: LigneCalculee[];
  totaux: TotauxFacture;
  versionReferentielFiscal: string;
  /** Vrai si le régime du redevable ne collecte pas la TVA (entreprenant, microentreprise). */
  exonereParRegime: boolean;
}

export class ErreurCalcul extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurCalcul';
  }
}

function validerLigne(ligne: LigneFacture): void {
  if (!Number.isFinite(ligne.quantite) || ligne.quantite <= 0) {
    throw new ErreurCalcul(
      `Ligne « ${ligne.designation} » : la quantité doit être strictement positive.`,
    );
  }
  if (!Number.isInteger(ligne.prixUnitaireHT) || ligne.prixUnitaireHT < 0) {
    throw new ErreurCalcul(
      `Ligne « ${ligne.designation} » : le prix unitaire doit être un entier de francs CFA positif.`,
    );
  }
  const remise = ligne.remisePourcent ?? 0;
  if (remise < 0 || remise > 100) {
    throw new ErreurCalcul(
      `Ligne « ${ligne.designation} » : la remise doit être comprise entre 0 et 100 %.`,
    );
  }
}

/**
 * Calcule une ligne de facture.
 *
 * Ordre d'arrondi retenu : brut HT arrondi → remise arrondie → HT net → TVA
 * arrondie sur le HT net. Chaque étape produit un entier de francs, ce qui rend
 * le total reconstituable ligne à ligne lors d'un contrôle.
 */
function calculerLigne(
  ligne: LigneFacture,
  referentiel: VersionReferentielFiscal,
  collecteTVA: boolean,
): LigneCalculee {
  validerLigne(ligne);

  const montantBrutHT = arrondirFranc(ligne.quantite * ligne.prixUnitaireHT);
  const montantRemise = appliquerTaux(montantBrutHT, ligne.remisePourcent ?? 0);
  const montantHT = montantBrutHT - montantRemise;

  const tauxTvaApplique = collecteTVA ? tauxPourCode(referentiel, ligne.codeTva) : 0;
  const montantTVA = appliquerTaux(montantHT, tauxTvaApplique);

  return {
    ...ligne,
    montantBrutHT,
    montantRemise,
    montantHT,
    tauxTvaApplique,
    montantTVA,
    montantTTC: montantHT + montantTVA,
  };
}

/**
 * Ventilation par taux.
 *
 * La TVA est recalculée sur la base agrégée du taux, et non sommée depuis les
 * lignes : sommer des arrondis ligne à ligne fait dériver le total de quelques
 * francs sur une facture longue, et c'est le total ventilé qui est déclaré.
 * L'écart éventuel avec la somme des lignes reste inférieur au franc par taux.
 */
function ventiler(lignes: readonly LigneCalculee[]): VentilationTVA[] {
  const parCode = new Map<CodeTVA, { taux: number; baseHT: MontantXOF }>();

  for (const ligne of lignes) {
    const existant = parCode.get(ligne.codeTva);
    if (existant) {
      existant.baseHT += ligne.montantHT;
    } else {
      parCode.set(ligne.codeTva, { taux: ligne.tauxTvaApplique, baseHT: ligne.montantHT });
    }
  }

  return [...parCode.entries()].map(([codeTva, { taux, baseHT }]) => ({
    codeTva,
    taux,
    baseHT,
    montantTVA: appliquerTaux(baseHT, taux),
  }));
}

export function calculerFacture(
  lignes: readonly LigneFacture[],
  contexte: ContexteCalcul,
): ResultatCalcul {
  if (lignes.length === 0) {
    throw new ErreurCalcul('Une facture doit comporter au moins une ligne.');
  }

  const referentiel = resoudreReferentiel(contexte.dateEmission, contexte.versionsReferentiel);
  const collecteTVA = estAssujettiTVA(referentiel, contexte.regimeFiscal);

  const lignesCalculees = lignes.map((l) => calculerLigne(l, referentiel, collecteTVA));
  const ventilation = ventiler(lignesCalculees);

  const totalBrutHT = somme(lignesCalculees.map((l) => l.montantBrutHT));
  const totalRemises = somme(lignesCalculees.map((l) => l.montantRemise));
  const totalHT = totalBrutHT - totalRemises;
  const totalTVA = somme(ventilation.map((v) => v.montantTVA));

  return {
    lignes: lignesCalculees,
    totaux: {
      totalBrutHT,
      totalRemises,
      totalHT,
      totalTVA,
      totalTTC: totalHT + totalTVA,
      ventilation,
    },
    versionReferentielFiscal: referentiel.version,
    exonereParRegime: !collecteTVA,
  };
}

/**
 * Recalcule et compare aux totaux annoncés par un terminal.
 * Utilisé côté serveur à la réception d'une facture émise hors ligne.
 */
export function verifierTotaux(
  lignes: readonly LigneFacture[],
  totauxAnnonces: TotauxFacture,
  contexte: ContexteCalcul,
): { conforme: boolean; ecarts: string[]; recalcul: ResultatCalcul } {
  const recalcul = calculerFacture(lignes, contexte);
  const ecarts: string[] = [];

  const champs: (keyof Pick<
    TotauxFacture,
    'totalBrutHT' | 'totalRemises' | 'totalHT' | 'totalTVA' | 'totalTTC'
  >)[] = ['totalBrutHT', 'totalRemises', 'totalHT', 'totalTVA', 'totalTTC'];

  for (const champ of champs) {
    if (recalcul.totaux[champ] !== totauxAnnonces[champ]) {
      ecarts.push(
        `${champ} : annoncé ${totauxAnnonces[champ]}, recalculé ${recalcul.totaux[champ]}`,
      );
    }
  }

  return { conforme: ecarts.length === 0, ecarts, recalcul };
}
