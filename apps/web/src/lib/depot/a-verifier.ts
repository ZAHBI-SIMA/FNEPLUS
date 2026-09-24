/**
 * Éléments demandant une intervention humaine.
 *
 * Tout ce que le terminal ne peut pas résoudre seul atterrit ici : facture
 * refusée définitivement par le serveur, commande abandonnée après trop
 * d'échecs, réserve de numéros épuisée.
 *
 * Le principe : une file d'attente qui grossit en silence est un incident qui se
 * découvre trop tard — le jour du contrôle fiscal. Ce que l'application ne peut
 * pas réparer toute seule, elle le montre, avec ce qu'il faut faire.
 */

import type { DepotLocal } from '../db/depot-local';

export type GraviteAnomalie = 'BLOQUANT' | 'A_CORRIGER';

export interface Anomalie {
  id: string;
  gravite: GraviteAnomalie;
  titre: string;
  detail: string;
  /** Ce que l'utilisateur peut faire, en une phrase. */
  action: string;
  /** Vrai si un nouvel essai a une chance d'aboutir. */
  reessayable: boolean;
  survenuLe?: string;
}

/**
 * Liste les anomalies en cours.
 *
 * Volontairement ordonnées par gravité : ce qui empêche de facturer passe avant
 * ce qui demande une correction comptable.
 */
export function listerAnomalies(base: DepotLocal, terminalId: string): Anomalie[] {
  const anomalies: Anomalie[] = [];

  // 1. Réserve de numéros épuisée — bloquant : plus aucune vente possible.
  const [reserve] = base.interroger<{ restants: number }>(
    `SELECT COALESCE(SUM(fin - curseur + 1), 0) AS restants FROM plages_numeros
      WHERE terminal_id = ? AND cloturee_le IS NULL AND curseur <= fin`,
    [terminalId],
  );

  if ((reserve?.restants ?? 0) === 0) {
    anomalies.push({
      id: 'reserve-epuisee',
      gravite: 'BLOQUANT',
      titre: 'Plus aucun numéro de facture disponible',
      detail:
        'Ce terminal a consommé toute sa réserve. Aucune nouvelle facture ne peut être émise.',
      action:
        'Connectez-vous quelques secondes : une nouvelle réserve sera chargée automatiquement.',
      reessayable: false,
    });
  }

  // 2. Factures refusées par le serveur — à corriger, avec le motif exact.
  const rejetees = base.interroger<{
    id: string;
    numero: string;
    motif_rejet: string | null;
    emise_le: string;
  }>(
    `SELECT id, numero, motif_rejet, emise_le FROM factures
      WHERE statut = 'REJETEE' ORDER BY emise_le DESC LIMIT 50`,
  );

  const facturesDejaListees = new Set<string>();

  for (const facture of rejetees) {
    facturesDejaListees.add(facture.id);
    anomalies.push({
      id: `facture-${facture.id}`,
      gravite: 'A_CORRIGER',
      titre: `Facture ${facture.numero} refusée`,
      detail: facture.motif_rejet ?? 'Refusée par le serveur, sans motif précisé.',
      action:
        'Cette facture a été remise au client mais n’est pas enregistrée. Contactez votre comptable ou le support avant d’émettre un avoir.',
      reessayable: true,
      survenuLe: facture.emise_le,
    });
  }

  // 3. Commandes abandonnées après épuisement des tentatives.
  const abandonnees = base.interroger<{
    id: string;
    type: string;
    charge_json: string;
    derniere_erreur: string | null;
    creee_le: string;
  }>(
    `SELECT id, type, charge_json, derniere_erreur, creee_le FROM outbox
      WHERE etat = 'ECHEC_DEFINITIF' ORDER BY creee_le DESC LIMIT 50`,
  );

  const LIBELLES: Record<string, string> = {
    CREER_FACTURE: 'Envoi d’une facture',
    UPSERT_CLIENT: 'Enregistrement d’un client',
    UPSERT_PRODUIT: 'Enregistrement d’un article',
    ENREGISTRER_PAIEMENT: 'Enregistrement d’un paiement',
    CLOTURER_PLAGE: 'Clôture d’une réserve de numéros',
  };

  for (const commande of abandonnees) {
    // Une commande d'envoi de facture et la facture refusée qu'elle portait
    // décrivent le MÊME incident. Les afficher toutes les deux doublerait le
    // compteur et proposerait deux actions contradictoires — « réessayez » d'un
    // côté, « contactez votre comptable » de l'autre. On garde l'entrée
    // « facture », la seule qui parle au commerçant.
    if (
      commande.type === 'CREER_FACTURE' &&
      estDejaListee(commande.charge_json, facturesDejaListees)
    ) {
      continue;
    }

    anomalies.push({
      id: `commande-${commande.id}`,
      gravite: 'A_CORRIGER',
      titre: `${LIBELLES[commande.type] ?? commande.type} en échec`,
      detail: commande.derniere_erreur ?? 'Le serveur a refusé cet envoi à plusieurs reprises.',
      action: 'Réessayez. Si l’échec persiste, contactez le support.',
      reessayable: true,
      survenuLe: commande.creee_le,
    });
  }

  return anomalies.sort((a, b) =>
    a.gravite === b.gravite ? 0 : a.gravite === 'BLOQUANT' ? -1 : 1,
  );
}

/** Vrai si la commande porte une facture déjà signalée comme refusée. */
function estDejaListee(chargeJson: string, dejaListees: Set<string>): boolean {
  try {
    const factureId = (JSON.parse(chargeJson) as { facture?: { id?: string } }).facture?.id;
    return factureId !== undefined && dejaListees.has(factureId);
  } catch {
    return false;
  }
}

export function compterAnomalies(base: DepotLocal, terminalId: string): number {
  return listerAnomalies(base, terminalId).length;
}

/**
 * Remet en file une commande abandonnée.
 *
 * Les compteurs de tentatives sont remis à zéro : c'est un nouvel essai décidé
 * par un humain, pas la suite d'une série automatique.
 */
export function reessayerCommande(base: DepotLocal, anomalieId: string): boolean {
  if (!anomalieId.startsWith('commande-')) return false;
  const commandeId = anomalieId.slice('commande-'.length);

  base.transaction(() => {
    base.executer(
      `UPDATE outbox
          SET etat = 'EN_ATTENTE', tentatives = 0, prochaine_tentative_le = NULL
        WHERE id = ? AND etat = 'ECHEC_DEFINITIF'`,
      [commandeId],
    );
    base.journaliser('OUTBOX_REESSAI_MANUEL', { commandeId });
  });

  return true;
}

/* ------------------------------------------------------------------ */
/* Stockage local                                                      */
/* ------------------------------------------------------------------ */

export interface EtatStockage {
  facturesConservees: number;
  commandesConfirmees: number;
  entreesJournal: number;
  /** Octets utilisés par l'origine, si le navigateur sait l'estimer. */
  octetsUtilises?: number;
  octetsDisponibles?: number;
}

/**
 * Purge des données dont on n'a plus besoin localement.
 *
 * Ce qui est purgé : commandes confirmées anciennes, et entrées de journal
 * d'audit au-delà d'un plafond.
 *
 * Ce qui ne l'est JAMAIS : les factures. Elles doivent être conservées pour la
 * durée légale, et une facture non encore transmise ne doit pas disparaître
 * parce que l'appareil manquait de place. Si le stockage sature, c'est à
 * l'utilisateur d'en être informé — pas au terminal d'effacer des pièces
 * comptables.
 */
export function purgerStockage(
  base: DepotLocal,
  options: { joursRetentionCommandes?: number; maxEntreesJournal?: number } = {},
): { commandesPurgees: number; entreesJournalPurgees: number } {
  const jours = options.joursRetentionCommandes ?? 30;
  const maxJournal = options.maxEntreesJournal ?? 5_000;
  const limite = new Date(Date.now() - jours * 86_400_000).toISOString();

  return base.transaction(() => {
    const [avant] = base.interroger<{ n: number }>(
      `SELECT COUNT(*) AS n FROM outbox WHERE etat = 'CONFIRMEE' AND creee_le < ?`,
      [limite],
    );
    base.executer(`DELETE FROM outbox WHERE etat = 'CONFIRMEE' AND creee_le < ?`, [limite]);

    const [journal] = base.interroger<{ n: number }>('SELECT COUNT(*) AS n FROM journal_audit');
    const surplus = Math.max(0, (journal?.n ?? 0) - maxJournal);
    if (surplus > 0) {
      base.executer(
        `DELETE FROM journal_audit WHERE id IN (
           SELECT id FROM journal_audit ORDER BY id ASC LIMIT ?
         )`,
        [surplus],
      );
    }

    return { commandesPurgees: avant?.n ?? 0, entreesJournalPurgees: surplus };
  });
}

export function etatStockage(base: DepotLocal): EtatStockage {
  const [factures] = base.interroger<{ n: number }>('SELECT COUNT(*) AS n FROM factures');
  const [commandes] = base.interroger<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox WHERE etat = 'CONFIRMEE'`,
  );
  const [journal] = base.interroger<{ n: number }>('SELECT COUNT(*) AS n FROM journal_audit');

  return {
    facturesConservees: factures?.n ?? 0,
    commandesConfirmees: commandes?.n ?? 0,
    entreesJournal: journal?.n ?? 0,
  };
}
