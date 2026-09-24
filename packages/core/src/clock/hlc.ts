/**
 * Horloge logique hybride (Hybrid Logical Clock).
 *
 * Problème concret : l'horloge d'un smartphone d'entrée de gamme dérive, se
 * remet à zéro après une batterie vide, ou est réglée à la main par
 * l'utilisateur. Or il faut pouvoir ordonner des modifications faites sur
 * plusieurs terminaux déconnectés, et arbitrer un conflit sur une fiche client.
 *
 * La HLC combine l'horloge murale (pour rester lisible par un humain) et un
 * compteur logique (pour rester monotone même si l'horloge murale recule). Deux
 * horodatages HLC sont toujours comparables, et le nœud d'origine départage les
 * égalités parfaites.
 */

/** Dérive maximale tolérée avec l'horloge serveur, au-delà de laquelle on alerte. */
export const DERIVE_MAX_MS = 5 * 60 * 1000;

export interface HorodatageHLC {
  /** Millisecondes depuis l'époque Unix. */
  murale: number;
  /** Compteur logique, incrémenté lors d'égalités sur `murale`. */
  compteur: number;
  /** Identifiant du terminal émetteur, départage les égalités parfaites. */
  noeud: string;
}

export function serialiserHLC(h: HorodatageHLC): string {
  return `${h.murale.toString().padStart(15, '0')}:${h.compteur.toString().padStart(5, '0')}:${h.noeud}`;
}

export function deserialiserHLC(valeur: string): HorodatageHLC {
  const [murale, compteur, ...reste] = valeur.split(':');
  if (murale === undefined || compteur === undefined || reste.length === 0) {
    throw new Error(`Horodatage HLC invalide : ${valeur}`);
  }
  return { murale: Number(murale), compteur: Number(compteur), noeud: reste.join(':') };
}

export function comparerHLC(a: HorodatageHLC, b: HorodatageHLC): number {
  if (a.murale !== b.murale) return a.murale - b.murale;
  if (a.compteur !== b.compteur) return a.compteur - b.compteur;
  return a.noeud < b.noeud ? -1 : a.noeud > b.noeud ? 1 : 0;
}

export class HorlogeHLC {
  private dernier: HorodatageHLC;
  /** Écart mesuré avec l'horloge serveur, appliqué à chaque lecture locale. */
  private deriveMs = 0;

  constructor(
    private readonly noeud: string,
    private readonly maintenant: () => number = () => Date.now(),
  ) {
    this.dernier = { murale: this.maintenant(), compteur: 0, noeud };
  }

  /** Horodatage pour un événement local. Toujours strictement croissant. */
  tick(): HorodatageHLC {
    const murale = this.maintenant() + this.deriveMs;
    if (murale > this.dernier.murale) {
      this.dernier = { murale, compteur: 0, noeud: this.noeud };
    } else {
      this.dernier = {
        murale: this.dernier.murale,
        compteur: this.dernier.compteur + 1,
        noeud: this.noeud,
      };
    }
    return { ...this.dernier };
  }

  /** Intègre un horodatage reçu (serveur ou autre terminal) et avance l'horloge. */
  observer(distant: HorodatageHLC): HorodatageHLC {
    const murale = this.maintenant() + this.deriveMs;
    const maxMurale = Math.max(murale, this.dernier.murale, distant.murale);

    let compteur: number;
    if (maxMurale === this.dernier.murale && maxMurale === distant.murale) {
      compteur = Math.max(this.dernier.compteur, distant.compteur) + 1;
    } else if (maxMurale === this.dernier.murale) {
      compteur = this.dernier.compteur + 1;
    } else if (maxMurale === distant.murale) {
      compteur = distant.compteur + 1;
    } else {
      compteur = 0;
    }

    this.dernier = { murale: maxMurale, compteur, noeud: this.noeud };
    return { ...this.dernier };
  }

  /**
   * Recale la dérive à partir de l'heure serveur reçue lors d'une synchronisation.
   * L'horloge locale n'est jamais modifiée — seule la correction appliquée l'est.
   */
  recaler(horodatageServeurMs: number): { deriveMs: number; deriveExcessive: boolean } {
    this.deriveMs = horodatageServeurMs - this.maintenant();
    return { deriveMs: this.deriveMs, deriveExcessive: Math.abs(this.deriveMs) > DERIVE_MAX_MS };
  }

  get derive(): number {
    return this.deriveMs;
  }
}
