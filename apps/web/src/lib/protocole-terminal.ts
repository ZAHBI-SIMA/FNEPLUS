/**
 * Protocole entre l'interface et le worker qui détient la base locale.
 *
 * Principe : le worker n'expose pas « exécute ce SQL », mais des opérations
 * métier complètes (« émets cette facture », « enregistre ce client »). La
 * transaction reste donc entièrement à l'intérieur du worker, et l'interface ne
 * peut pas la découper en plusieurs allers-retours entre lesquels l'appareil
 * s'éteindrait.
 */

import type { LigneFacture, RegimeFiscal } from '@fneplus/core';
import type { InfosBaseLocale } from './db/base-locale';
import type { ResumeFacture, TotauxJour } from './depot/factures';
import type { LigneClient } from './depot/clients';
import type { LigneProduit } from './depot/produits';
import type { Anomalie, EtatStockage } from './depot/a-verifier';
import type { EtatReglementLocal } from './depot/paiements';
import type { ResultatSynchronisation } from './synchronisation';

export type ActionTerminal =
  | 'INITIALISER'
  | 'ETAT'
  | 'INSCRIRE'
  | 'DEMANDER_CODE'
  | 'VERIFIER_CODE'
  | 'CONNEXION_PIN'
  | 'DEFINIR_PIN'
  | 'DECONNEXION'
  | 'EMETTRE_FACTURE'
  | 'ENREGISTRER_CLIENT'
  | 'LISTER_CLIENTS'
  | 'ENREGISTRER_PRODUIT'
  | 'LISTER_PRODUITS'
  | 'LISTER_ANOMALIES'
  | 'REESSAYER'
  | 'PURGER_STOCKAGE'
  | 'SYNCHRONISER'
  | 'ENCAISSER_ESPECES'
  | 'DEMANDER_PAIEMENT_MOBILE'
  | 'ETAT_REGLEMENT'
  | 'SITUATION_ARF';

export interface RequeteTerminal {
  id: number;
  action: ActionTerminal;
  charge?: unknown;
}

export interface ReponseTerminal {
  id: number;
  ok: boolean;
  resultat?: unknown;
  erreur?: { message: string; nom: string; code?: string };
}

export interface ResumeSession {
  nom: string;
  role: 'PROPRIETAIRE' | 'CAISSIER' | 'COMPTABLE';
  raisonSociale: string;
  regimeFiscal: RegimeFiscal;
  terminalId: string;
  derniereSync?: string;
}

export interface EtatTerminal {
  infos: InfosBaseLocale;
  /** Absent tant qu'aucun compte n'est connecté sur cet appareil. */
  session: ResumeSession | null;
  factures: ResumeFacture[];
  totaux: TotauxJour;
  enAttente: number;
  echecs: number;
  numerosRestants: number;
  alertePlage: boolean;
  nombreClients: number;
  nombreProduits: number;
  /** Éléments demandant une intervention humaine. */
  nombreAnomalies: number;
  /** NCC de l'entreprise, nécessaire au contenu du QR. */
  ncc?: string;
}

export interface ChargeInscription {
  ncc: string;
  raisonSociale: string;
  regimeFiscal: RegimeFiscal;
  telephone: string;
  adresse?: string;
  nomProprietaire: string;
}

export interface ChargeConnexion {
  telephone: string;
  /** Code reçu par SMS, ou code PIN selon l'action appelée. */
  code: string;
  /** Nom donné à cet appareil lors du premier appairage. */
  libelleAppareil?: string;
}

export interface ResultatConnexion {
  etat: EtatTerminal;
  /** Vrai si l'utilisateur doit encore choisir un code PIN. */
  definirPin: boolean;
}

export interface ChargeEmission {
  clientNom: string;
  clientId?: string;
  /** Affichée sur le reçu ; ne fait pas partie du document légal archivé. */
  clientAdresse?: string;
  lignes: Omit<LigneFacture, 'id'>[];
}

/** Ligne du reçu, telle qu'affichée dans le tableau de la facture normalisée. */
export interface LigneRecu {
  designation: string;
  quantite: number;
  prixUnitaireTTC: number;
  montantTTC: number;
}

export interface ResultatEmission {
  factureId: string;
  numero: string;
  totalTTC: number;
  totalTVA: number;
  emiseLe: string;
  clientNom: string;
  clientAdresse?: string;
  lignes: LigneRecu[];
  /** Contenu à encoder dans le QR remis au client. */
  contenuQR: string;
  /** Vrai tant que la DGI n'a pas certifié la facture. */
  qrProvisoire: boolean;
  /** Durée mesurée dans le worker, hors coût de message. */
  dureeMs: number;
}

export interface ChargeProduit {
  id?: string;
  designation: string;
  prixUnitaireHT: number;
  codeTva: 'TVA_NORMAL' | 'TVA_REDUIT' | 'EXONERE' | 'HORS_CHAMP';
  reference?: string;
}

export type ResultatProduits = LigneProduit[];
export type ResultatAnomalies = Anomalie[];
export type { Anomalie, EtatStockage };

export interface ChargeClient {
  id?: string;
  nom: string;
  ncc?: string;
  telephone?: string;
  email?: string;
  adresse?: string;
}

export type ResultatClients = LigneClient[];
export type { ResultatSynchronisation };

/* ------------------------------------------------------------------ */
/* Encaissement                                                         */
/* ------------------------------------------------------------------ */

export type MoyenPaiementTerminal = 'ESPECES' | 'ORANGE_MONEY' | 'MTN_MOMO' | 'WAVE' | 'MOOV_MONEY';

export interface ChargeEncaissementEspeces {
  factureId: string;
  montant: number;
}

export interface ChargePaiementMobile {
  factureId: string;
  moyen: Exclude<MoyenPaiementTerminal, 'ESPECES'>;
  montant: number;
  telephone?: string;
}

/**
 * Demande de paiement mobile money créée chez le prestataire.
 *
 * Exige le réseau : contrairement à l'émission d'une facture, cette opération
 * appelle directement l'API et échoue proprement si le terminal est hors ligne
 * — il n'y a rien à mettre en file, la demande n'a de sens qu'immédiate.
 */
export interface ResultatPaiementMobile {
  id: string;
  statut: string;
  lienPaiement?: string;
  reference?: string;
}

export type { EtatReglementLocal };

/* ------------------------------------------------------------------ */
/* ARF                                                                  */
/* ------------------------------------------------------------------ */

export type StatutARF = 'A_JOUR' | 'BIENTOT_EXPIREE' | 'EXPIREE' | 'AUCUNE' | 'REVOQUEE';

export interface SituationARF {
  statut: StatutARF;
  numero?: string;
  delivreeLe?: string;
  expireLe?: string;
  joursAvantExpiration?: number;
  message: string;
}
