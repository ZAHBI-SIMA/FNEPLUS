/**
 * Encaissement, côté terminal.
 *
 * Deux chemins, volontairement séparés :
 *
 *  - **Espèces** : le caissier a l'argent en main, le règlement est immédiat et
 *    certain. Il s'enregistre entièrement hors ligne, comme une facture — écrit
 *    en local et empilé dans l'outbox dans la même transaction.
 *
 *  - **Mobile money** : régler suppose de créer une demande chez un prestataire
 *    externe, ce qui exige le réseau au moment de la demande. Ce chemin ne
 *    passe pas par ici : il appelle directement l'API (`api-client.ts`), et le
 *    résultat (lien de paiement, état) n'est pas écrit en local tant que le
 *    règlement n'est pas confirmé.
 */

import { uuidv7, type HorodatageHLC } from '@fneplus/core';
import type { DepotLocal } from '../db/depot-local';
import { empiler } from '../outbox';

export interface SaisiePaiementEspeces {
  factureId: string;
  montant: number;
}

export interface EtatReglementLocal {
  factureId: string;
  totalTTC: number;
  montantRegle: number;
  resteADevoir: number;
  regleeLe: string | null;
}

export class ErreurPaiement extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurPaiement';
  }
}

/**
 * Enregistre un règlement en espèces.
 *
 * Écriture et mise en file dans la même transaction que la facture : si
 * l'appareil s'éteint entre les deux, on ne se retrouve jamais avec un
 * paiement enregistré qui ne partira jamais, ni avec une commande qui décrit
 * un paiement inexistant.
 */
export function enregistrerPaiementEspeces(
  base: DepotLocal,
  contexte: { entrepriseId: string; terminalId: string; hlc: HorodatageHLC },
  saisie: SaisiePaiementEspeces,
): EtatReglementLocal {
  const [facture] = base.interroger<{ total_ttc: number; montant_regle: number }>(
    'SELECT total_ttc, montant_regle FROM factures WHERE id = ?',
    [saisie.factureId],
  );
  if (!facture) {
    throw new ErreurPaiement('Facture introuvable sur ce terminal.');
  }
  if (!Number.isInteger(saisie.montant) || saisie.montant <= 0) {
    throw new ErreurPaiement('Le montant doit être un entier de francs CFA positif.');
  }

  const reste = facture.total_ttc - facture.montant_regle;
  if (saisie.montant > reste) {
    throw new ErreurPaiement(
      `Le montant dépasse ce qui reste à régler (${reste.toLocaleString('fr-CI')} F CFA).`,
    );
  }

  const paiementId = uuidv7();
  const maintenant = new Date().toISOString();
  const nouveauMontantRegle = facture.montant_regle + saisie.montant;
  const soldee = nouveauMontantRegle >= facture.total_ttc;

  base.transaction(() => {
    base.executer(
      `INSERT INTO paiements (id, entreprise_id, facture_id, moyen, montant, statut, demande_le, regle_le)
       VALUES (?, ?, ?, 'ESPECES', ?, 'REGLEE', ?, ?)`,
      [paiementId, contexte.entrepriseId, saisie.factureId, saisie.montant, maintenant, maintenant],
    );
    base.executer(
      `UPDATE factures SET montant_regle = ?, reglee_le = COALESCE(reglee_le, ?) WHERE id = ?`,
      [nouveauMontantRegle, soldee ? maintenant : null, saisie.factureId],
    );

    empiler(base, {
      id: uuidv7(),
      type: 'ENREGISTRER_PAIEMENT',
      entrepriseId: contexte.entrepriseId,
      terminalId: contexte.terminalId,
      hlc: contexte.hlc,
      creeeLe: maintenant,
      charge: {
        factureId: saisie.factureId,
        montant: saisie.montant,
        moyen: 'ESPECES',
        referenceExterne: paiementId,
      },
    });

    base.journaliser('PAIEMENT_ESPECES_ENREGISTRE', {
      factureId: saisie.factureId,
      montant: saisie.montant,
    });
  });

  return {
    factureId: saisie.factureId,
    totalTTC: facture.total_ttc,
    montantRegle: nouveauMontantRegle,
    resteADevoir: Math.max(0, facture.total_ttc - nouveauMontantRegle),
    regleeLe: soldee ? maintenant : null,
  };
}

export function etatReglementLocal(base: DepotLocal, factureId: string): EtatReglementLocal | null {
  const [facture] = base.interroger<{
    total_ttc: number;
    montant_regle: number;
    reglee_le: string | null;
  }>('SELECT total_ttc, montant_regle, reglee_le FROM factures WHERE id = ?', [factureId]);

  if (!facture) return null;

  return {
    factureId,
    totalTTC: facture.total_ttc,
    montantRegle: facture.montant_regle,
    resteADevoir: Math.max(0, facture.total_ttc - facture.montant_regle),
    regleeLe: facture.reglee_le,
  };
}

/**
 * Répercute en local le règlement constaté par le serveur.
 *
 * Un paiement mobile money se règle uniquement côté serveur : le webhook du
 * prestataire ne touche jamais l'appareil. Sans ce recalage, l'écran de
 * caisse continuerait d'afficher « reste à devoir » indéfiniment après un
 * règlement pourtant confirmé — c'est ce recalage qui fait fonctionner le
 * rapprochement automatique, pas le seul sondage de l'écran.
 */
export function appliquerReglementServeur(
  base: DepotLocal,
  etat: { factureId: string; totalTTC: number; montantRegle: number; regleeLe?: string | null },
): EtatReglementLocal {
  base.executer(`UPDATE factures SET montant_regle = ?, reglee_le = ? WHERE id = ?`, [
    etat.montantRegle,
    etat.regleeLe ?? null,
    etat.factureId,
  ]);

  return {
    factureId: etat.factureId,
    totalTTC: etat.totalTTC,
    montantRegle: etat.montantRegle,
    resteADevoir: Math.max(0, etat.totalTTC - etat.montantRegle),
    regleeLe: etat.regleeLe ?? null,
  };
}
