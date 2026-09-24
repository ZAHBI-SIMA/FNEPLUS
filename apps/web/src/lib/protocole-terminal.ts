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
  | 'SYNCHRONISER';

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
  lignes: Omit<LigneFacture, 'id'>[];
}

export interface ResultatEmission {
  numero: string;
  totalTTC: number;
  /** Durée mesurée dans le worker, hors coût de message. */
  dureeMs: number;
}

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
