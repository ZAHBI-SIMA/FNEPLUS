/**
 * Arithmétique monétaire XOF.
 *
 * Le franc CFA (XOF) n'a pas de subdivision en usage : tout montant facturé est
 * un entier de francs. On ne manipule donc jamais de flottant pour un montant
 * stocké ou transmis — uniquement des entiers, arrondis explicitement à chaque
 * étape de calcul.
 */

/** Montant en francs CFA. Toujours un entier. */
export type MontantXOF = number;

export const DEVISE = 'XOF' as const;

export class ErreurMontant extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurMontant';
  }
}

/**
 * Arrondi commercial (demi-supérieur, symétrique autour de zéro).
 * `Math.round` arrondit -0.5 vers 0, ce qui n'est pas le comportement attendu
 * pour un avoir : on force la symétrie.
 */
export function arrondirFranc(valeur: number): MontantXOF {
  if (!Number.isFinite(valeur)) {
    throw new ErreurMontant(`Valeur monétaire non finie : ${valeur}`);
  }
  return Math.sign(valeur) * Math.round(Math.abs(valeur));
}

export function estMontantValide(valeur: unknown): valeur is MontantXOF {
  return typeof valeur === 'number' && Number.isInteger(valeur) && Number.isSafeInteger(valeur);
}

export function assertMontant(valeur: unknown, champ = 'montant'): asserts valeur is MontantXOF {
  if (!estMontantValide(valeur)) {
    throw new ErreurMontant(
      `Le champ « ${champ} » doit être un entier de francs CFA (reçu : ${String(valeur)})`,
    );
  }
}

export function somme(montants: readonly MontantXOF[]): MontantXOF {
  let total = 0;
  for (const m of montants) {
    assertMontant(m, 'élément de somme');
    total += m;
  }
  if (!Number.isSafeInteger(total)) {
    throw new ErreurMontant('Dépassement de capacité sur une somme monétaire');
  }
  return total;
}

/**
 * Applique un pourcentage à un montant et arrondit au franc.
 * Le taux est exprimé en points de pourcentage (18 pour 18 %).
 */
export function appliquerTaux(base: MontantXOF, tauxPourcent: number): MontantXOF {
  assertMontant(base, 'base');
  return arrondirFranc((base * tauxPourcent) / 100);
}

/** Formatage destiné à l'affichage : « 1 250 000 F CFA ». */
export function formaterXOF(montant: MontantXOF, options?: { avecDevise?: boolean }): string {
  assertMontant(montant, 'montant');
  const corps = new Intl.NumberFormat('fr-CI', {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(montant);
  return options?.avecDevise === false ? corps : `${corps} F CFA`;
}
