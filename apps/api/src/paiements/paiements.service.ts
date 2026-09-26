/**
 * Encaissement et rapprochement.
 *
 * Le rapprochement automatique est ce qui distingue un encaissement mobile money
 * utilisable d'un gadget : sans lui, le commerçant doit vérifier son téléphone,
 * retrouver la transaction et cocher la facture à la main — autant encaisser en
 * espèces.
 *
 * Deux garanties portent ce module :
 *
 *  - **Une notification non signée n'a aucun effet.** Sans cette vérification,
 *    n'importe qui pourrait déclarer une facture payée en appelant notre
 *    webhook. C'est le contrôle le plus important de tout le module.
 *  - **Une notification rejouée ne crédite qu'une fois.** Les agrégateurs
 *    renvoient leurs notifications quand ils n'ont pas reçu d'accusé ; une
 *    facture ne doit pas se retrouver payée deux fois.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@fneplus/core';
import { BaseDeDonnees, JETON_CONFIG, type TransactionSql } from '../db/db.module.js';
import type { Configuration } from '../config.js';
import { AgregateurClient } from './agregateur.client.js';
import {
  ErreurPrestataire,
  type NotificationPaiement,
  type Operateur,
  type StatutPaiement,
} from './prestataire.js';

export type MoyenPaiement = Operateur | 'ESPECES' | 'VIREMENT' | 'AUTRE';

export interface DemandeEncaissement {
  factureId: string;
  moyen: MoyenPaiement;
  montant: number;
  telephone?: string;
}

export interface Encaissement {
  id: string;
  factureId: string;
  moyen: MoyenPaiement;
  montant: number;
  statut: StatutPaiement;
  /** Absent pour un encaissement en espèces. */
  lienPaiement?: string;
  reference?: string;
}

export interface EtatReglement {
  factureId: string;
  totalTTC: number;
  montantRegle: number;
  resteADevoir: number;
  regleeLe?: string;
  paiements: {
    moyen: string;
    montant: number;
    statut: string;
    demandeLe: string;
    regleLe?: string;
  }[];
}

/** Moyens qui passent par un prestataire externe. */
const MOYENS_MOBILES: MoyenPaiement[] = ['ORANGE_MONEY', 'MTN_MOMO', 'WAVE', 'MOOV_MONEY'];

@Injectable()
export class PaiementsService {
  private readonly logger = new Logger(PaiementsService.name);

  /**
   * Enregistre un règlement déjà constaté sur le terminal, hors ligne.
   *
   * Distinct de `encaisser()` : ce dernier ouvre une demande de paiement
   * auprès d'un prestataire et exige donc le réseau. Ici, le caissier a
   * lui-même constaté le règlement — espèces en main, ou confirmation mobile
   * money lue sur l'écran du client — et le déclare a posteriori. Aucun appel
   * externe n'est possible ni nécessaire.
   *
   * Méthode statique participant à la transaction de l'appelant, sur le même
   * principe que `TransmissionService.mettreEnFile` : la synchronisation gère
   * une transaction par commande, et ce paiement doit s'y inscrire plutôt que
   * d'en ouvrir une nouvelle.
   */
  static async enregistrerReglementDirect(
    tx: TransactionSql,
    entrepriseId: string,
    paiementId: string,
    donnees: {
      factureId: string;
      montant: number;
      moyen: MoyenPaiement;
      referenceExterne?: string;
    },
  ): Promise<{ accepte: boolean; motif?: string; definitif?: boolean }> {
    const [facture] = await tx<{ id: string; total_ttc: number; montant_regle: number }[]>`
      SELECT id, total_ttc, montant_regle FROM factures WHERE id = ${donnees.factureId}
    `;

    if (!facture) {
      return { accepte: false, motif: 'Facture introuvable.', definitif: true };
    }

    if (!Number.isInteger(donnees.montant) || donnees.montant <= 0) {
      return { accepte: false, motif: 'Montant de paiement invalide.', definitif: true };
    }

    // Idempotence de fond : l'appelant (sync.service) garantit déjà qu'une
    // commande n'est appliquée qu'une fois. Une référence externe déjà connue
    // signale malgré tout un doublon accepté sans le recréer, plutôt que de le
    // refuser — un rejeu ne doit jamais bloquer une synchronisation.
    if (donnees.referenceExterne) {
      const [existant] = await tx<{ id: string }[]>`
        SELECT id FROM paiements WHERE reference_externe = ${donnees.referenceExterne}
      `;
      if (existant) return { accepte: true, motif: 'Paiement déjà enregistré.' };
    }

    await tx`
      INSERT INTO paiements (id, entreprise_id, facture_id, moyen, montant, statut, reference_externe, regle_le)
      VALUES (${paiementId}, ${entrepriseId}, ${donnees.factureId}, ${donnees.moyen},
              ${donnees.montant}, ${'REGLEE'}, ${donnees.referenceExterne ?? null}, now())
      ON CONFLICT (id) DO NOTHING
    `;

    await recalculerReglementDansTransaction(tx, donnees.factureId);

    return { accepte: true };
  }

  constructor(
    @Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees,
    @Inject(AgregateurClient) private readonly prestataire: AgregateurClient,
    @Inject(JETON_CONFIG) private readonly config: Configuration,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Encaissement                                                        */
  /* ------------------------------------------------------------------ */

  async encaisser(entrepriseId: string, demande: DemandeEncaissement): Promise<Encaissement> {
    const facture = await this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [f] = await tx<{ id: string; total_ttc: number; montant_regle: number }[]>`
        SELECT id, total_ttc, montant_regle FROM factures WHERE id = ${demande.factureId}
      `;
      return f;
    });

    if (!facture) {
      throw new ErreurPrestataire('Facture introuvable.', false);
    }

    const reste = facture.total_ttc - facture.montant_regle;
    if (demande.montant > reste) {
      throw new ErreurPrestataire(
        `Le montant dépasse ce qui reste à régler (${reste} F CFA).`,
        false,
      );
    }

    const id = uuidv7();

    // Espèces : rien à demander à personne, le règlement est immédiat.
    if (!MOYENS_MOBILES.includes(demande.moyen)) {
      await this.bdd.avecTenant(entrepriseId, async (tx) => {
        await tx`
          INSERT INTO paiements (id, entreprise_id, facture_id, moyen, montant, statut, regle_le)
          VALUES (${id}, ${entrepriseId}, ${demande.factureId}, ${demande.moyen},
                  ${demande.montant}, ${'REGLEE'}, now())
        `;
      });
      await this.recalculerReglement(entrepriseId, demande.factureId);

      return {
        id,
        factureId: demande.factureId,
        moyen: demande.moyen,
        montant: demande.montant,
        statut: 'REGLEE',
      };
    }

    const cree = await this.prestataire.creerDemande({
      referenceExterne: id,
      montant: demande.montant,
      operateur: demande.moyen as Operateur,
      ...(demande.telephone ? { telephone: demande.telephone } : {}),
      urlWebhook: `${this.config.API_URL_PUBLIQUE}/api/v1/paiements/webhook`,
    });

    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        INSERT INTO paiements (
          id, entreprise_id, facture_id, moyen, montant, statut,
          reference_externe, lien_paiement, telephone
        ) VALUES (
          ${id}, ${entrepriseId}, ${demande.factureId}, ${demande.moyen}, ${demande.montant},
          ${'EN_ATTENTE'}, ${cree.reference}, ${cree.lienPaiement}, ${demande.telephone ?? null}
        )
      `;
    });

    return {
      id,
      factureId: demande.factureId,
      moyen: demande.moyen,
      montant: demande.montant,
      statut: 'EN_ATTENTE',
      lienPaiement: cree.lienPaiement,
      reference: cree.reference,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Webhook                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Traite une notification du prestataire.
   *
   * Renvoie toujours un résultat plutôt que de lever : un webhook qui reçoit une
   * erreur HTTP est renvoyé en boucle par l'agrégateur, ce qui transforme un
   * incident isolé en tempête de requêtes.
   */
  async traiterNotification(
    corpsBrut: string,
    signature: string | undefined,
  ): Promise<{ accepte: boolean; motif?: string }> {
    if (!this.prestataire.verifierSignature(corpsBrut, signature)) {
      this.logger.warn('Notification de paiement avec signature invalide : ignorée.');
      return { accepte: false, motif: 'Signature invalide.' };
    }

    let corps: unknown;
    try {
      corps = JSON.parse(corpsBrut);
    } catch {
      return { accepte: false, motif: 'Corps illisible.' };
    }

    const notification = this.prestataire.lireNotification(corps);
    if (!notification) return { accepte: false, motif: 'Notification incompréhensible.' };

    return this.appliquerNotification(notification);
  }

  private async appliquerNotification(
    notification: NotificationPaiement,
  ): Promise<{ accepte: boolean; motif?: string }> {
    // Le prestataire ne connaît que sa référence : on retrouve le paiement sans
    // contexte tenant, par une fonction dédiée.
    const [paiement] = await this.bdd.horsTenant(
      async (tx) =>
        await tx<
          {
            id: string;
            entreprise_id: string;
            facture_id: string;
            montant: number;
            statut: string;
          }[]
        >`SELECT * FROM fneplus_paiement_par_reference(${notification.reference})`,
    );

    if (!paiement) {
      this.logger.warn(`Notification pour une référence inconnue : ${notification.reference}`);
      return { accepte: false, motif: 'Paiement inconnu.' };
    }

    // Rejeu : l'agrégateur renvoie ses notifications tant qu'il n'a pas d'accusé.
    // Un paiement déjà réglé ne doit pas créditer une seconde fois.
    if (paiement.statut === 'REGLEE') {
      return { accepte: true, motif: 'Paiement déjà enregistré.' };
    }

    // Montant différent de l'attendu : on n'invente rien, on enregistre ce qui a
    // réellement été reçu et le reste à devoir s'ajuste.
    const montantRecu = notification.montant > 0 ? notification.montant : paiement.montant;

    await this.bdd.avecTenant(paiement.entreprise_id, async (tx) => {
      await tx`
        UPDATE paiements
           SET statut = ${notification.statut},
               montant = ${montantRecu},
               regle_le = ${notification.statut === 'REGLEE' ? (notification.regleLe ?? new Date().toISOString()) : null}
         WHERE id = ${paiement.id}
      `;
    });

    if (notification.statut === 'REGLEE') {
      await this.recalculerReglement(paiement.entreprise_id, paiement.facture_id);
      this.logger.log(
        `Paiement ${notification.reference} réglé : ${montantRecu} F CFA (${notification.operateur}).`,
      );
    }

    return { accepte: true };
  }

  /* ------------------------------------------------------------------ */
  /* Rapprochement                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Recalcule l'état de règlement d'une facture.
   *
   * Recalculé à partir des paiements plutôt qu'incrémenté : un compteur
   * incrémenté dérive dès qu'une notification est rejouée ou qu'un paiement est
   * corrigé. La somme des paiements réglés est la seule source fiable.
   */
  private async recalculerReglement(entrepriseId: string, factureId: string): Promise<void> {
    await this.bdd.avecTenant(entrepriseId, (tx) =>
      recalculerReglementDansTransaction(tx, factureId),
    );
  }

  /**
   * Réconcilie les paiements en attente depuis trop longtemps.
   *
   * Un webhook peut se perdre — le réseau coupe, notre service redémarre au
   * mauvais moment. Sans cette relecture, une facture réellement payée
   * resterait éternellement impayée dans le produit.
   */
  async reconcilierEnAttente(ageMinimalMs = 60_000): Promise<{ verifies: number; regles: number }> {
    const limite = new Date(Date.now() - ageMinimalMs);

    const enAttente = await this.bdd.horsTenant(
      async (tx) =>
        await tx<{ reference_externe: string }[]>`
          SELECT reference_externe FROM paiements
           WHERE statut = 'EN_ATTENTE' AND reference_externe IS NOT NULL AND demande_le < ${limite}
           LIMIT 50
        `,
    );

    let regles = 0;
    for (const { reference_externe } of enAttente) {
      try {
        const etat = await this.prestataire.consulter(reference_externe);
        if (etat.statut !== 'EN_ATTENTE') {
          const resultat = await this.appliquerNotification({
            reference: etat.reference,
            referenceExterne: etat.referenceExterne,
            statut: etat.statut,
            montant: etat.montant,
            operateur: etat.operateur,
          });
          if (resultat.accepte && etat.statut === 'REGLEE') regles++;
        }
      } catch (erreur) {
        this.logger.warn(`Réconciliation impossible pour ${reference_externe} : ${String(erreur)}`);
      }
    }

    return { verifies: enAttente.length, regles };
  }

  /* ------------------------------------------------------------------ */
  /* Consultation                                                        */
  /* ------------------------------------------------------------------ */

  async etatReglement(entrepriseId: string, factureId: string): Promise<EtatReglement | null> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [facture] = await tx<
        { total_ttc: number; montant_regle: number; reglee_le: Date | null }[]
      >`SELECT total_ttc, montant_regle, reglee_le FROM factures WHERE id = ${factureId}`;

      if (!facture) return null;

      const paiements = await tx<
        {
          moyen: string;
          montant: number;
          statut: string;
          demande_le: Date;
          regle_le: Date | null;
        }[]
      >`
        SELECT moyen, montant, statut, demande_le, regle_le FROM paiements
         WHERE facture_id = ${factureId} ORDER BY demande_le ASC
      `;

      return {
        factureId,
        totalTTC: facture.total_ttc,
        montantRegle: facture.montant_regle,
        resteADevoir: Math.max(0, facture.total_ttc - facture.montant_regle),
        ...(facture.reglee_le ? { regleeLe: facture.reglee_le.toISOString() } : {}),
        paiements: paiements.map((p) => ({
          moyen: p.moyen,
          montant: p.montant,
          statut: p.statut,
          demandeLe: p.demande_le.toISOString(),
          ...(p.regle_le ? { regleLe: p.regle_le.toISOString() } : {}),
        })),
      };
    });
  }
}

/**
 * Recalcule l'état de règlement d'une facture dans une transaction donnée.
 *
 * Fonction de module, pas méthode privée : partagée entre l'instance
 * (`recalculerReglement`, qui ouvre sa propre transaction) et la méthode
 * statique `enregistrerReglementDirect` (qui participe à la transaction de son
 * appelant). Recalculé à partir des paiements plutôt qu'incrémenté : un
 * compteur incrémenté dérive dès qu'une notification est rejouée ou qu'un
 * paiement est corrigé. La somme des paiements réglés est la seule source
 * fiable.
 */
async function recalculerReglementDansTransaction(
  tx: TransactionSql,
  factureId: string,
): Promise<void> {
  await tx`
    UPDATE factures f
       SET montant_regle = COALESCE((
             SELECT SUM(p.montant) FROM paiements p
              WHERE p.facture_id = f.id AND p.statut = 'REGLEE'
           ), 0),
           reglee_le = CASE
             WHEN COALESCE((
               SELECT SUM(p.montant) FROM paiements p
                WHERE p.facture_id = f.id AND p.statut = 'REGLEE'
             ), 0) >= f.total_ttc THEN COALESCE(f.reglee_le, now())
             ELSE NULL
           END
     WHERE f.id = ${factureId}
  `;
}
