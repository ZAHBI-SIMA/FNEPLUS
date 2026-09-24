/**
 * Disjoncteur du connecteur DGI.
 *
 * Quand l'API de l'administration tombe, le pire comportement est de continuer
 * à lui envoyer des milliers de factures : on sature le service, on épuise nos
 * propres ressources, et on transforme une panne passagère en panne longue des
 * deux côtés.
 *
 * Le disjoncteur coupe après un nombre d'échecs consécutifs, laisse le service
 * respirer, puis laisse passer UNE requête d'essai. Si elle réussit, le circuit
 * se referme ; sinon il se rouvre pour une nouvelle période.
 *
 * Ce qu'il ne fait pas : perdre des factures. Une transmission empêchée par un
 * disjoncteur ouvert reste dans la file et repartira. C'est la file qui garantit
 * la livraison, le disjoncteur ne fait que choisir le moment.
 */

export type EtatDisjoncteur =
  /** Tout passe. */
  | 'FERME'
  /** Rien ne passe : l'API est considérée en panne. */
  | 'OUVERT'
  /** Une requête d'essai est autorisée, pour voir si le service est revenu. */
  | 'SEMI_OUVERT';

export interface OptionsDisjoncteur {
  /** Échecs consécutifs avant ouverture. */
  seuilEchecs?: number;
  /** Durée d'ouverture avant d'autoriser un essai, en millisecondes. */
  dureeOuvertureMs?: number;
  /** Succès consécutifs en semi-ouvert avant refermeture complète. */
  succesPourFermer?: number;
  maintenant?: () => number;
}

export class DisjoncteurOuvert extends Error {
  constructor(readonly reouvertureDansMs: number) {
    super(
      `Le service de la DGI est considéré indisponible. Nouvelle tentative dans ${Math.ceil(
        reouvertureDansMs / 1000,
      )} s.`,
    );
    this.name = 'DisjoncteurOuvert';
  }
}

export class Disjoncteur {
  private etatCourant: EtatDisjoncteur = 'FERME';
  private echecsConsecutifs = 0;
  private succesConsecutifs = 0;
  private ouvertDepuis = 0;

  private readonly seuilEchecs: number;
  private readonly dureeOuvertureMs: number;
  private readonly succesPourFermer: number;
  private readonly maintenant: () => number;

  constructor(options: OptionsDisjoncteur = {}) {
    this.seuilEchecs = options.seuilEchecs ?? 5;
    this.dureeOuvertureMs = options.dureeOuvertureMs ?? 30_000;
    this.succesPourFermer = options.succesPourFermer ?? 2;
    this.maintenant = options.maintenant ?? (() => Date.now());
  }

  get etat(): EtatDisjoncteur {
    this.rafraichir();
    return this.etatCourant;
  }

  /** Vrai si une requête peut être tentée maintenant. */
  autorise(): boolean {
    this.rafraichir();
    return this.etatCourant !== 'OUVERT';
  }

  /**
   * Exécute un appel sous protection du disjoncteur.
   *
   * L'appelant distingue les échecs qui comptent (service injoignable, erreur
   * serveur) de ceux qui ne comptent pas : un rejet métier de la DGI signifie
   * que le service fonctionne parfaitement, et ne doit surtout pas ouvrir le
   * circuit.
   */
  async executer<T>(appel: () => Promise<T>): Promise<T> {
    this.rafraichir();

    if (this.etatCourant === 'OUVERT') {
      throw new DisjoncteurOuvert(this.dureeOuvertureMs - (this.maintenant() - this.ouvertDepuis));
    }

    try {
      const resultat = await appel();
      this.signalerSucces();
      return resultat;
    } catch (erreur) {
      this.signalerEchec();
      throw erreur;
    }
  }

  signalerSucces(): void {
    this.echecsConsecutifs = 0;

    if (this.etatCourant === 'SEMI_OUVERT') {
      this.succesConsecutifs++;
      if (this.succesConsecutifs >= this.succesPourFermer) {
        this.etatCourant = 'FERME';
        this.succesConsecutifs = 0;
      }
      return;
    }

    this.etatCourant = 'FERME';
  }

  signalerEchec(): void {
    this.succesConsecutifs = 0;

    // Un échec pendant l'essai de reprise rouvre immédiatement : inutile de
    // recompter jusqu'au seuil, on sait déjà que le service n'est pas revenu.
    if (this.etatCourant === 'SEMI_OUVERT') {
      this.ouvrir();
      return;
    }

    this.echecsConsecutifs++;
    if (this.echecsConsecutifs >= this.seuilEchecs) this.ouvrir();
  }

  private ouvrir(): void {
    this.etatCourant = 'OUVERT';
    this.ouvertDepuis = this.maintenant();
    this.echecsConsecutifs = 0;
  }

  private rafraichir(): void {
    if (this.etatCourant !== 'OUVERT') return;
    if (this.maintenant() - this.ouvertDepuis >= this.dureeOuvertureMs) {
      this.etatCourant = 'SEMI_OUVERT';
      this.succesConsecutifs = 0;
    }
  }

  /** Remise à zéro manuelle, pour les tests et une reprise décidée par un humain. */
  reinitialiser(): void {
    this.etatCourant = 'FERME';
    this.echecsConsecutifs = 0;
    this.succesConsecutifs = 0;
  }
}
