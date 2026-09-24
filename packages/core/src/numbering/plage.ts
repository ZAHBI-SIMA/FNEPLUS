/**
 * Numérotation séquentielle infalsifiable, compatible hors ligne.
 *
 * Le problème : la DGI exige une numérotation séquentielle sans trou ni doublon,
 * mais un terminal déconnecté ne peut pas demander « le numéro suivant » au
 * serveur. Le compteur local partagé est impossible dès qu'il y a deux caisses.
 *
 * La solution retenue : le serveur alloue à chaque TERMINAL un bloc de numéros
 * réservé pour lui seul. Hors ligne, le terminal consomme son bloc. Deux
 * terminaux ne peuvent donc jamais produire le même numéro, même après plusieurs
 * jours sans réseau.
 *
 * Les blocs partiellement consommés sont clôturés et journalisés à la
 * synchronisation : les numéros non utilisés d'un bloc clos sont déclarés comme
 * tels, ce qui explique les trous de séquence lors d'un contrôle au lieu de les
 * subir.
 */

export interface PlageNumeros {
  id: string;
  entrepriseId: string;
  pointDeVenteId: string;
  terminalId: string;
  /** Préfixe imprimé sur le document, ex. « ABJ01-2026 ». */
  prefixe: string;
  /** Premier numéro du bloc (inclus). */
  debut: number;
  /** Dernier numéro du bloc (inclus). */
  fin: number;
  /** Prochain numéro à consommer. Égal à `fin + 1` quand le bloc est épuisé. */
  curseur: number;
  /** Nombre de chiffres du compteur imprimé, ex. 6 → « 000042 ». */
  longueurCompteur: number;
  allouceLe: string;
  clotureeLe?: string;
}

/** Sous ce nombre de numéros restants, l'utilisateur est invité à se reconnecter. */
export const SEUIL_ALERTE_PLAGE = 0.2;

export class ErreurPlage extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurPlage';
  }
}

export class PlageEpuisee extends ErreurPlage {
  constructor() {
    super(
      'La réserve de numéros de ce terminal est épuisée. Connectez-vous quelques secondes pour en recharger une nouvelle.',
    );
    this.name = 'PlageEpuisee';
  }
}

export function tailleePlage(plage: PlageNumeros): number {
  return plage.fin - plage.debut + 1;
}

export function numerosRestants(plage: PlageNumeros): number {
  if (plage.clotureeLe) return 0;
  return Math.max(0, plage.fin - plage.curseur + 1);
}

export function plageBientotEpuisee(plage: PlageNumeros): boolean {
  const taille = tailleePlage(plage);
  if (taille <= 0) return true;
  return numerosRestants(plage) / taille <= SEUIL_ALERTE_PLAGE;
}

export function formaterNumero(plage: PlageNumeros, compteur: number): string {
  return `${plage.prefixe}-${String(compteur).padStart(plage.longueurCompteur, '0')}`;
}

export interface NumeroConsomme {
  numero: string;
  compteur: number;
  /** Plage après consommation. Le curseur est avancé : l'appel n'est pas idempotent. */
  plage: PlageNumeros;
}

/**
 * Consomme le prochain numéro de la plage.
 *
 * L'appelant DOIT persister la plage retournée dans la même transaction locale
 * que la facture créée. Si la facture n'est pas persistée, le numéro est perdu :
 * c'est volontaire, un numéro consommé ne se recycle pas.
 */
export function consommerNumero(plage: PlageNumeros): NumeroConsomme {
  if (plage.clotureeLe) {
    throw new ErreurPlage('Cette plage de numéros a été clôturée et ne peut plus être utilisée.');
  }
  if (plage.curseur > plage.fin) {
    throw new PlageEpuisee();
  }

  const compteur = plage.curseur;
  return {
    numero: formaterNumero(plage, compteur),
    compteur,
    plage: { ...plage, curseur: compteur + 1 },
  };
}

/**
 * Clôture une plage avant épuisement (rechargement anticipé, terminal retiré du
 * service, révocation). Les numéros non consommés sont déclarés inutilisés.
 */
export function cloturerPlage(
  plage: PlageNumeros,
  date: string,
): { plage: PlageNumeros; numerosNonUtilises: number } {
  if (plage.clotureeLe) {
    return { plage, numerosNonUtilises: 0 };
  }
  return {
    plage: { ...plage, clotureeLe: date },
    numerosNonUtilises: numerosRestants(plage),
  };
}

/** Vérifie qu'une séquence de compteurs consommés ne comporte ni trou ni doublon. */
export function verifierContinuite(compteurs: readonly number[]): {
  continue: boolean;
  doublons: number[];
  trous: number[];
} {
  const tries = [...compteurs].sort((a, b) => a - b);
  const doublons: number[] = [];
  const trous: number[] = [];

  for (let i = 1; i < tries.length; i++) {
    const precedent = tries[i - 1]!;
    const courant = tries[i]!;
    if (courant === precedent) {
      doublons.push(courant);
    } else if (courant > precedent + 1) {
      for (let manquant = precedent + 1; manquant < courant; manquant++) {
        trous.push(manquant);
      }
    }
  }

  return { continue: doublons.length === 0 && trous.length === 0, doublons, trous };
}
