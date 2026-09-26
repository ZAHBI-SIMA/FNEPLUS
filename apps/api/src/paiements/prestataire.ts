/**
 * Abstraction du prestataire de paiement mobile.
 *
 * ⚠️ Le choix entre agrégateur (CinetPay, PayDunya, Hub2) et intégration directe
 * opérateur par opérateur n'est pas tranché — point bloquant n° 4 du plan, avec
 * un délai d'accès de deux à huit semaines selon la voie retenue.
 *
 * Cette interface existe pour que ce choix reste une décision d'exploitation et
 * non une réécriture. Le reste du produit ne connaît que quatre opérations :
 * demander un paiement, lire son état, vérifier une notification, interpréter
 * un règlement.
 *
 * Point de vigilance : chaque opérateur a ses propres codes de statut et ses
 * propres formats de signature. Toute cette diversité doit être absorbée ici,
 * jamais remontée dans le métier.
 */

export type Operateur = 'ORANGE_MONEY' | 'MTN_MOMO' | 'WAVE' | 'MOOV_MONEY';

export const OPERATEURS: { code: Operateur; libelle: string }[] = [
  { code: 'ORANGE_MONEY', libelle: 'Orange Money' },
  { code: 'MTN_MOMO', libelle: 'MTN Mobile Money' },
  { code: 'WAVE', libelle: 'Wave' },
  { code: 'MOOV_MONEY', libelle: 'Moov Money' },
];

export type StatutPaiement =
  /** Demande créée, le client n'a pas encore réglé. */
  | 'EN_ATTENTE'
  | 'REGLEE'
  /** Le client a annulé ou le délai a expiré. */
  | 'ABANDONNEE'
  /** L'opérateur a refusé (solde insuffisant, compte bloqué). */
  | 'REFUSEE';

export interface DemandePaiement {
  /** Identifiant de la facture à régler : sert de clé d'idempotence. */
  referenceExterne: string;
  montant: number;
  operateur: Operateur;
  telephone?: string;
  /** URL que le prestataire appellera à la confirmation. */
  urlWebhook: string;
}

export interface PaiementCree {
  /** Référence chez le prestataire. */
  reference: string;
  referenceExterne: string;
  montant: number;
  operateur: Operateur;
  statut: StatutPaiement;
  /** Lien à présenter au client, encodé en QR sur le terminal. */
  lienPaiement: string;
}

export interface NotificationPaiement {
  reference: string;
  referenceExterne: string;
  statut: StatutPaiement;
  montant: number;
  operateur: Operateur;
  regleLe?: string;
}

export class ErreurPrestataire extends Error {
  constructor(
    message: string,
    /** Vrai si un nouvel essai a une chance d'aboutir. */
    readonly reessayable: boolean,
  ) {
    super(message);
    this.name = 'ErreurPrestataire';
  }
}

export interface PrestatairePaiement {
  /** Crée une demande de paiement et rend le lien à présenter au client. */
  creerDemande(demande: DemandePaiement): Promise<PaiementCree>;

  /** Consulte l'état d'un paiement, quand le webhook n'est pas arrivé. */
  consulter(reference: string): Promise<PaiementCree>;

  /**
   * Vérifie qu'une notification vient bien du prestataire.
   *
   * Sans cette vérification, n'importe qui pourrait déclarer une facture payée
   * en appelant notre webhook. C'est le contrôle le plus important de tout le
   * module.
   */
  verifierSignature(corpsBrut: string, signature: string | undefined): boolean;

  /** Traduit une notification dans le vocabulaire du produit. */
  lireNotification(corps: unknown): NotificationPaiement | null;
}
