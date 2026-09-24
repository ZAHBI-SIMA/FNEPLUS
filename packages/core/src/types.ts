/**
 * Types du domaine FNE+.
 *
 * Ce module est partagé entre le client (PWA) et le serveur (API) : toute règle
 * qui doit produire le même résultat hors ligne et en ligne vit ici, et nulle
 * part ailleurs.
 */

import type { MontantXOF } from './money.js';

/* ------------------------------------------------------------------ */
/* Entreprise et régime fiscal                                         */
/* ------------------------------------------------------------------ */

/**
 * Régimes d'imposition ivoiriens.
 * Seuls les régimes réels (RSI, RNI) sont assujettis à la TVA ; l'entreprenant
 * et la microentreprise relèvent d'un impôt synthétique et ne la collectent pas.
 *
 * NOTE : les seuils associés sont dans `tax/referentiel.ts`, versionnés par date
 * d'effet. Ils doivent être confirmés auprès de la DGI avant mise en production.
 */
export type RegimeFiscal = 'ENTREPRENANT' | 'MICROENTREPRISE' | 'REEL_SIMPLIFIE' | 'REEL_NORMAL';

export interface Entreprise {
  id: string;
  /** Numéro de Compte Contribuable attribué par la DGI. */
  ncc: string;
  raisonSociale: string;
  regimeFiscal: RegimeFiscal;
  adresse: string;
  telephone: string;
  email?: string;
  /** Points de vente rattachés. Une entreprise en a toujours au moins un. */
  pointsDeVente: PointDeVente[];
}

export interface PointDeVente {
  id: string;
  entrepriseId: string;
  libelle: string;
  /** Code court utilisé dans la numérotation des factures. */
  code: string;
  adresse?: string;
}

/**
 * Un terminal est un appareil physique (smartphone, tablette, poste de caisse).
 * C'est l'unité qui reçoit les plages de numéros pré-allouées : deux terminaux
 * ne peuvent jamais consommer le même numéro, même déconnectés pendant des jours.
 */
export interface Terminal {
  id: string;
  entrepriseId: string;
  pointDeVenteId: string;
  libelle: string;
  /** Clé publique de l'appareil, utilisée pour signer les factures émises hors ligne. */
  clePubliqueAppareil?: string;
  revoqueLe?: string;
}

/* ------------------------------------------------------------------ */
/* Clients et catalogue                                                */
/* ------------------------------------------------------------------ */

export interface Client {
  id: string;
  entrepriseId: string;
  nom: string;
  /** NCC du client, obligatoire pour une facture B2B. */
  ncc?: string;
  telephone?: string;
  email?: string;
  adresse?: string;
}

export interface Produit {
  id: string;
  entrepriseId: string;
  designation: string;
  prixUnitaireHT: MontantXOF;
  codeTva: CodeTVA;
  reference?: string;
}

/* ------------------------------------------------------------------ */
/* Fiscalité                                                           */
/* ------------------------------------------------------------------ */

/**
 * Code de taxation d'une ligne. Le taux associé n'est jamais écrit en dur dans
 * le code applicatif : il est résolu par le référentiel versionné en fonction de
 * la date d'émission de la facture.
 */
export type CodeTVA = 'TVA_NORMAL' | 'TVA_REDUIT' | 'EXONERE' | 'HORS_CHAMP';

/* ------------------------------------------------------------------ */
/* Factures                                                            */
/* ------------------------------------------------------------------ */

export type TypeDocument = 'FACTURE' | 'AVOIR' | 'ACOMPTE' | 'RECTIFICATIVE';

/**
 * Cycle de vie d'une facture, tel qu'il est montré à l'utilisateur.
 * Un seul indicateur à l'écran, toujours visible.
 */
export type StatutFacture =
  /** Saisie en cours, jamais remise au client. */
  | 'BROUILLON'
  /** Émise sur le terminal : numéro consommé, document remis au client. Irréversible. */
  | 'EMISE_LOCALEMENT'
  /** Poussée vers le serveur, en attente de transmission à la DGI. */
  | 'EN_FILE_DGI'
  /** Transmise à la DGI, accusé de réception reçu. */
  | 'TRANSMISE'
  /** Certifiée par la DGI (identifiant de certification reçu). */
  | 'CERTIFIEE'
  /** Rejetée par la DGI : un motif et une action corrective sont toujours associés. */
  | 'REJETEE';

export interface LigneFacture {
  id: string;
  designation: string;
  quantite: number;
  prixUnitaireHT: MontantXOF;
  codeTva: CodeTVA;
  /** Remise en points de pourcentage appliquée à la ligne (0 à 100). */
  remisePourcent?: number;
  produitId?: string;
}

/** Résultat du calcul fiscal d'une ligne. Toujours recalculable, jamais saisi. */
export interface LigneCalculee extends LigneFacture {
  montantBrutHT: MontantXOF;
  montantRemise: MontantXOF;
  montantHT: MontantXOF;
  tauxTvaApplique: number;
  montantTVA: MontantXOF;
  montantTTC: MontantXOF;
}

export interface VentilationTVA {
  codeTva: CodeTVA;
  taux: number;
  baseHT: MontantXOF;
  montantTVA: MontantXOF;
}

export interface TotauxFacture {
  totalBrutHT: MontantXOF;
  totalRemises: MontantXOF;
  totalHT: MontantXOF;
  totalTVA: MontantXOF;
  totalTTC: MontantXOF;
  ventilation: VentilationTVA[];
}

export interface Facture {
  id: string;
  entrepriseId: string;
  pointDeVenteId: string;
  terminalId: string;
  type: TypeDocument;
  statut: StatutFacture;

  /** Numéro séquentiel consommé dans la plage allouée au terminal. */
  numero: string;
  /** Horodatage d'émission tel que déclaré par le terminal (horloge locale, faillible). */
  emiseLe: string;
  /** Horodatage certifié posé par le serveur à la réception. Absent tant que hors ligne. */
  horodatageCertifie?: string;

  clientId?: string;
  clientNom: string;
  clientNcc?: string;

  lignes: LigneFacture[];
  totaux: TotauxFacture;

  /** Version du référentiel fiscal utilisée pour le calcul. Trace d'audit indispensable. */
  versionReferentielFiscal: string;

  /** Chaînage d'intégrité : hash de la facture précédente de la même entreprise. */
  hashPrecedent: string;
  hash: string;

  /** Renseigné après certification par la DGI. */
  identifiantCertificationDGI?: string;
  /** Contenu encodé dans le QR code remis au client. */
  contenuQR?: string;

  /** Pour un avoir ou une rectificative : la facture d'origine. */
  factureOrigineId?: string;

  motifRejet?: string;
}

/* ------------------------------------------------------------------ */
/* Synchronisation                                                     */
/* ------------------------------------------------------------------ */

export type EtatReseau = 'EN_LIGNE' | 'HORS_LIGNE' | 'SYNCHRONISATION';

export interface EtatSynchronisation {
  etatReseau: EtatReseau;
  /** Nombre de commandes en attente dans l'outbox local. */
  enAttente: number;
  derniereSyncReussie?: string;
  /** Numéros restants dans la plage allouée au terminal. */
  numerosRestants: number;
  /** Vrai sous le seuil d'alerte : il faut se reconnecter pour recharger une plage. */
  plageBientotEpuisee: boolean;
}
