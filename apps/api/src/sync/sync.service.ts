/**
 * Synchronisation des terminaux.
 *
 * Deux garanties portent tout le hors-ligne :
 *
 * 1. **Idempotence.** Chaque commande porte un UUIDv7 généré sur l'appareil.
 *    Avant de l'appliquer, on tente de l'insérer dans `commandes_traitees` ;
 *    si elle y est déjà, on renvoie le résultat mémorisé sans rien réappliquer.
 *    Un lot rejoué après une coupure en plein envoi ne crée donc jamais de
 *    doublon — c'est exactement le cas qui se produit sur un réseau mobile
 *    ivoirien qui lâche au milieu d'un POST.
 *
 * 2. **Ordre causal.** Les conflits entre terminaux se tranchent sur
 *    l'horodatage logique hybride, pas sur l'heure d'arrivée au serveur : un
 *    terminal resté trois jours hors ligne ne doit pas écraser une modification
 *    plus récente faite ailleurs, simplement parce qu'il se reconnecte après.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  calculerFacture,
  deserialiserHLC,
  comparerHLC,
  serialiserHLC,
  verifierTotaux,
  type Commande,
  type Facture,
  type LigneFacture,
  type RegimeFiscal,
  type ResultatCommande,
} from '@fneplus/core';
import { BaseDeDonnees, type TransactionSql } from '../db/db.module.js';

export interface DemandeSynchronisation {
  terminalId: string;
  commandes: Commande[];
  /** Horodatage de la dernière synchronisation réussie, pour le delta. */
  depuis?: string;
}

export interface DeltaSynchronisation {
  clients: Record<string, unknown>[];
  produits: Record<string, unknown>[];
  /** Horodatage serveur à conserver pour la prochaine demande de delta. */
  jusqua: string;
}

export interface ReponseSync {
  resultats: ResultatCommande[];
  delta: DeltaSynchronisation;
  /** Heure serveur, utilisée par le terminal pour recaler sa dérive d'horloge. */
  horodatageServeur: number;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(@Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees) {}

  async synchroniser(entrepriseId: string, demande: DemandeSynchronisation): Promise<ReponseSync> {
    const resultats: ResultatCommande[] = [];

    // Les commandes sont appliquées dans leur ordre causal, pas dans l'ordre
    // d'arrivée du tableau : un client mal implémenté ne doit pas pouvoir
    // inverser deux modifications.
    const ordonnees = [...demande.commandes].sort((a, b) => comparerHLC(a.hlc, b.hlc));

    for (const commande of ordonnees) {
      // Chaque commande a sa propre transaction : une commande refusée n'annule
      // pas les précédentes, déjà acquittées auprès du terminal.
      try {
        const resultat = await this.bdd.avecTenant(entrepriseId, (tx) =>
          this.appliquerCommande(tx, entrepriseId, commande),
        );
        resultats.push(resultat);
      } catch (erreur) {
        this.logger.error(
          `Commande ${commande.id} (${commande.type}) en échec : ${String(erreur)}`,
        );
        resultats.push({
          commandeId: commande.id,
          accepte: false,
          motif: 'Erreur interne du serveur. La commande sera renvoyée automatiquement.',
          definitif: false,
        });
      }
    }

    const delta = await this.calculerDelta(entrepriseId, demande.depuis);
    await this.marquerTerminalVu(entrepriseId, demande.terminalId);

    return { resultats, delta, horodatageServeur: Date.now() };
  }

  /* ------------------------------------------------------------------ */
  /* Application d'une commande                                          */
  /* ------------------------------------------------------------------ */

  private async appliquerCommande(
    tx: TransactionSql,
    entrepriseId: string,
    commande: Commande,
  ): Promise<ResultatCommande> {
    const hlcSerialise = serialiserHLC(commande.hlc);

    // Verrou d'idempotence : l'insertion échoue silencieusement si la commande
    // a déjà été traitée. C'est la base de données qui arbitre, pas un `SELECT`
    // préalable qui laisserait une fenêtre de concurrence.
    const insere = await tx<{ id: string }[]>`
      INSERT INTO commandes_traitees (id, entreprise_id, terminal_id, type, hlc, resultat)
      VALUES (${commande.id}, ${entrepriseId}, ${commande.terminalId}, ${commande.type},
              ${hlcSerialise}, ${tx.json({ enCours: true })})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    if (insere.length === 0) {
      const [precedent] = await tx<{ resultat: ResultatCommande }[]>`
        SELECT resultat FROM commandes_traitees WHERE id = ${commande.id}
      `;
      return (
        precedent?.resultat ?? { commandeId: commande.id, accepte: true, motif: 'Déjà traitée.' }
      );
    }

    const resultat = await this.executer(tx, entrepriseId, commande);

    await tx`
      UPDATE commandes_traitees SET resultat = ${tx.json(resultat as never)}
       WHERE id = ${commande.id}
    `;

    return resultat;
  }

  private async executer(
    tx: TransactionSql,
    entrepriseId: string,
    commande: Commande,
  ): Promise<ResultatCommande> {
    switch (commande.type) {
      case 'UPSERT_CLIENT':
        return this.upsertClient(tx, entrepriseId, commande);
      case 'UPSERT_PRODUIT':
        return this.upsertProduit(tx, entrepriseId, commande);
      case 'CLOTURER_PLAGE':
        return this.cloturerPlage(tx, commande);
      case 'CREER_FACTURE':
        return this.creerFacture(tx, entrepriseId, commande);
      case 'ENREGISTRER_PAIEMENT':
        // Traité au Sprint 5, avec l'encaissement mobile money. Refuser
        // temporairement vaut mieux qu'accepter en silence sans rien écrire.
        return {
          commandeId: commande.id,
          accepte: false,
          motif: 'L’enregistrement des paiements n’est pas encore disponible.',
          definitif: false,
        };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Référentiels — résolution de conflit par HLC                        */
  /* ------------------------------------------------------------------ */

  private async upsertClient(
    tx: TransactionSql,
    entrepriseId: string,
    commande: Extract<Commande, { type: 'UPSERT_CLIENT' }>,
  ): Promise<ResultatCommande> {
    const { client } = commande.charge;
    const hlc = serialiserHLC(commande.hlc);

    const [existant] = await tx<{ hlc: string }[]>`
      SELECT hlc FROM clients WHERE id = ${client.id}
    `;

    // Une écriture plus ancienne n'écrase pas une plus récente. Elle est
    // acceptée du point de vue du terminal — sa commande est bien traitée — mais
    // sans effet sur l'état, et le motif le dit explicitement.
    if (existant && comparerHLC(deserialiserHLC(existant.hlc), commande.hlc) > 0) {
      return {
        commandeId: commande.id,
        accepte: true,
        motif: 'Une modification plus récente de cette fiche existe déjà.',
      };
    }

    await tx`
      INSERT INTO clients (id, entreprise_id, nom, ncc, telephone, email, adresse, hlc, maj_le)
      VALUES (${client.id}, ${entrepriseId}, ${client.nom}, ${client.ncc ?? null},
              ${client.telephone ?? null}, ${client.email ?? null}, ${client.adresse ?? null},
              ${hlc}, now())
      ON CONFLICT (id) DO UPDATE SET
        nom = EXCLUDED.nom, ncc = EXCLUDED.ncc, telephone = EXCLUDED.telephone,
        email = EXCLUDED.email, adresse = EXCLUDED.adresse,
        hlc = EXCLUDED.hlc, maj_le = now()
    `;

    return { commandeId: commande.id, accepte: true };
  }

  private async upsertProduit(
    tx: TransactionSql,
    entrepriseId: string,
    commande: Extract<Commande, { type: 'UPSERT_PRODUIT' }>,
  ): Promise<ResultatCommande> {
    const { produit } = commande.charge;
    const hlc = serialiserHLC(commande.hlc);

    const [existant] = await tx<{ hlc: string }[]>`
      SELECT hlc FROM produits WHERE id = ${produit.id}
    `;

    if (existant && comparerHLC(deserialiserHLC(existant.hlc), commande.hlc) > 0) {
      return {
        commandeId: commande.id,
        accepte: true,
        motif: 'Une modification plus récente de cet article existe déjà.',
      };
    }

    await tx`
      INSERT INTO produits (id, entreprise_id, designation, prix_unitaire_ht, code_tva,
                            reference, hlc, maj_le)
      VALUES (${produit.id}, ${entrepriseId}, ${produit.designation}, ${produit.prixUnitaireHT},
              ${produit.codeTva}, ${produit.reference ?? null}, ${hlc}, now())
      ON CONFLICT (id) DO UPDATE SET
        designation = EXCLUDED.designation, prix_unitaire_ht = EXCLUDED.prix_unitaire_ht,
        code_tva = EXCLUDED.code_tva, reference = EXCLUDED.reference,
        hlc = EXCLUDED.hlc, maj_le = now()
    `;

    return { commandeId: commande.id, accepte: true };
  }

  private async cloturerPlage(
    tx: TransactionSql,
    commande: Extract<Commande, { type: 'CLOTURER_PLAGE' }>,
  ): Promise<ResultatCommande> {
    await tx`
      UPDATE plages_numeros
         SET cloturee_le = now(), numeros_non_utilises = ${commande.charge.numerosNonUtilises}
       WHERE id = ${commande.charge.plageId} AND cloturee_le IS NULL
    `;
    return { commandeId: commande.id, accepte: true };
  }

  /* ------------------------------------------------------------------ */
  /* Factures                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Réception d'une facture émise hors ligne.
   *
   * Le serveur RECALCULE systématiquement les totaux avec le même moteur que le
   * terminal (`@fneplus/core`) et les compare à ceux annoncés. Un écart signifie
   * terminal compromis, bogue de version ou référentiel désynchronisé : dans les
   * trois cas la facture part en revue plutôt qu'en transmission silencieuse à
   * la DGI.
   */
  private async creerFacture(
    tx: TransactionSql,
    entrepriseId: string,
    commande: Extract<Commande, { type: 'CREER_FACTURE' }>,
  ): Promise<ResultatCommande> {
    const { facture, lignes } = commande.charge as { facture: Facture; lignes: LigneFacture[] };

    const [entreprise] = await tx<{ regime_fiscal: RegimeFiscal }[]>`
      SELECT regime_fiscal FROM entreprises WHERE id = ${entrepriseId}
    `;
    if (!entreprise) {
      return {
        commandeId: commande.id,
        accepte: false,
        motif: 'Entreprise introuvable.',
        definitif: true,
      };
    }

    const controle = verifierTotaux(lignes, facture.totaux, {
      dateEmission: facture.emiseLe,
      regimeFiscal: entreprise.regime_fiscal,
    });

    if (!controle.conforme) {
      this.logger.warn(
        `Écart de calcul sur la facture ${facture.numero} : ${controle.ecarts.join(' ; ')}`,
      );
      return {
        commandeId: commande.id,
        accepte: false,
        motif:
          'Les montants de cette facture ne correspondent pas au calcul officiel. Elle a été mise de côté pour vérification.',
        definitif: true,
      };
    }

    // Recalculée plutôt que reprise telle quelle : c'est la version du serveur
    // qui fait foi et qui partira à la DGI.
    //
    // Le contenu du QR, lui, est conservé TEL QUE le terminal l'a produit : c'est
    // le code physiquement remis au client, et c'est celui-là qu'il faudra
    // pouvoir retrouver si quelqu'un le scanne des mois plus tard.
    const recalcul = calculerFacture(lignes, {
      dateEmission: facture.emiseLe,
      regimeFiscal: entreprise.regime_fiscal,
    });

    const insere = await tx<{ id: string }[]>`
      INSERT INTO factures (
        id, entreprise_id, point_de_vente_id, terminal_id, type, statut, numero, emise_le,
        client_id, client_nom, client_ncc, total_ht, total_tva, total_ttc, totaux, lignes,
        version_referentiel, hash_precedent, hash, contenu_qr, facture_origine_id
      ) VALUES (
        ${facture.id}, ${entrepriseId}, ${facture.pointDeVenteId}, ${facture.terminalId},
        ${facture.type}, ${'EN_FILE_DGI'}, ${facture.numero}, ${facture.emiseLe},
        ${facture.clientId ?? null}, ${facture.clientNom}, ${facture.clientNcc ?? null},
        ${recalcul.totaux.totalHT}, ${recalcul.totaux.totalTVA}, ${recalcul.totaux.totalTTC},
        ${tx.json(recalcul.totaux as never)}, ${tx.json(lignes as never)},
        ${recalcul.versionReferentielFiscal}, ${facture.hashPrecedent}, ${facture.hash},
        ${facture.contenuQR ?? null}, ${facture.factureOrigineId ?? null}
      )
      ON CONFLICT (entreprise_id, numero) DO NOTHING
      RETURNING id
    `;

    if (insere.length === 0) {
      // Le numéro existe déjà. Si c'est la même facture, c'est un rejeu et tout
      // va bien ; si c'est une autre, la réserve de numéros du terminal a été
      // violée et il faut un humain.
      const [existante] = await tx<{ id: string }[]>`
        SELECT id FROM factures WHERE entreprise_id = ${entrepriseId} AND numero = ${facture.numero}
      `;
      if (existante?.id === facture.id) {
        return { commandeId: commande.id, accepte: true, motif: 'Facture déjà enregistrée.' };
      }
      return {
        commandeId: commande.id,
        accepte: false,
        motif: `Le numéro ${facture.numero} est déjà utilisé par une autre facture.`,
        definitif: true,
      };
    }

    return { commandeId: commande.id, accepte: true };
  }

  /* ------------------------------------------------------------------ */
  /* Delta descendant                                                    */
  /* ------------------------------------------------------------------ */

  private async calculerDelta(
    entrepriseId: string,
    depuis?: string,
  ): Promise<DeltaSynchronisation> {
    // Époque Unix par défaut : un terminal neuf reçoit tout le référentiel.
    const borne = depuis ? new Date(depuis) : new Date(0);

    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const clients = await tx<Record<string, unknown>[]>`
        SELECT id, nom, ncc, telephone, email, adresse, hlc, supprime, maj_le
          FROM clients WHERE maj_le > ${borne} ORDER BY maj_le ASC LIMIT 500
      `;

      const produits = await tx<Record<string, unknown>[]>`
        SELECT id, designation, prix_unitaire_ht, code_tva, reference, hlc, supprime, maj_le
          FROM produits WHERE maj_le > ${borne} ORDER BY maj_le ASC LIMIT 500
      `;

      return { clients, produits, jusqua: new Date().toISOString() };
    });
  }

  private async marquerTerminalVu(entrepriseId: string, terminalId: string): Promise<void> {
    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`UPDATE terminaux SET vu_le = now() WHERE id = ${terminalId}`;
    });
  }
}
