/**
 * Commandes de synchronisation.
 *
 * Toute action de l'utilisateur devient une commande persistée localement, puis
 * appliquée à la base locale, puis poussée. Le serveur les applique de façon
 * idempotente grâce à `id` : un même lot renvoyé après une coupure en plein
 * envoi ne crée pas de doublon. C'est ce qui permet de couper le réseau à
 * n'importe quel instant sans perdre ni dupliquer une facture.
 */

import type { HorodatageHLC } from '../clock/hlc.js';
import type { Client, Facture, LigneFacture, Produit } from '../types.js';

export type TypeCommande =
  'CREER_FACTURE' | 'ENREGISTRER_PAIEMENT' | 'UPSERT_CLIENT' | 'UPSERT_PRODUIT' | 'CLOTURER_PLAGE';

interface CommandeBase<T extends TypeCommande, P> {
  /** UUIDv7 généré sur l'appareil : clé d'idempotence côté serveur. */
  id: string;
  type: T;
  entrepriseId: string;
  terminalId: string;
  /** Ordonnancement causal entre terminaux. */
  hlc: HorodatageHLC;
  /** Horodatage local lisible, conservé comme métadonnée d'audit. */
  creeeLe: string;
  charge: P;
}

export type CommandeCreerFacture = CommandeBase<
  'CREER_FACTURE',
  {
    facture: Facture;
    /** Lignes envoyées telles quelles : le serveur recalcule et compare. */
    lignes: LigneFacture[];
  }
>;

export type CommandeEnregistrerPaiement = CommandeBase<
  'ENREGISTRER_PAIEMENT',
  {
    factureId: string;
    montant: number;
    moyen: 'ESPECES' | 'ORANGE_MONEY' | 'MTN_MOMO' | 'WAVE' | 'MOOV_MONEY' | 'VIREMENT' | 'AUTRE';
    referenceExterne?: string;
  }
>;

export type CommandeUpsertClient = CommandeBase<'UPSERT_CLIENT', { client: Client }>;
export type CommandeUpsertProduit = CommandeBase<'UPSERT_PRODUIT', { produit: Produit }>;
export type CommandeCloturerPlage = CommandeBase<
  'CLOTURER_PLAGE',
  { plageId: string; numerosNonUtilises: number; motif: string }
>;

export type Commande =
  | CommandeCreerFacture
  | CommandeEnregistrerPaiement
  | CommandeUpsertClient
  | CommandeUpsertProduit
  | CommandeCloturerPlage;

/** État d'une commande dans l'outbox local. */
export type EtatCommande = 'EN_ATTENTE' | 'EN_COURS' | 'CONFIRMEE' | 'ECHEC_DEFINITIF';

export interface EntreeOutbox {
  commande: Commande;
  etat: EtatCommande;
  tentatives: number;
  prochaineTentativeLe?: string;
  derniereErreur?: string;
}

/** Repli exponentiel avec gigue, borné. Évite la ruée au retour du réseau. */
export function delaiAvantNouvelleTentative(tentatives: number): number {
  const base = Math.min(2 ** tentatives * 1000, 5 * 60 * 1000);
  const gigue = Math.random() * base * 0.3;
  return Math.round(base + gigue);
}

export const MAX_TENTATIVES = 12;

export interface ResultatCommande {
  commandeId: string;
  accepte: boolean;
  /** Renseigné en cas de refus : message en français, destiné à l'utilisateur. */
  motif?: string;
  /** Vrai si le refus est définitif : inutile de réessayer. */
  definitif?: boolean;
}

export interface ReponseSynchronisation {
  resultats: ResultatCommande[];
  /** Heure serveur, utilisée pour recaler la dérive d'horloge du terminal. */
  horodatageServeur: number;
}
