/**
 * Service de transmission à la DGI.
 *
 * C'est la pièce qui tient la promesse « aucune facture perdue ». Son contrat :
 *
 *  - Une facture reçue d'un terminal entre en file et n'en sort que certifiée
 *    ou explicitement rejetée. Jamais oubliée.
 *  - L'API de la DGI peut être injoignable pendant des heures : la file attend,
 *    le disjoncteur évite de la marteler, et tout repart au rétablissement.
 *  - Une transmission rejouée ne crée pas de doublon côté DGI, grâce à la clé
 *    d'idempotence portée par l'identifiant de facture.
 *
 * La file vit dans PostgreSQL plutôt que dans Redis. C'est un choix : ces
 * factures sont des pièces comptables, et leur file doit survivre à une perte de
 * Redis comme à un redémarrage. Une transaction couvre à la fois l'avancement de
 * la file et la mise à jour de la facture — impossible avec deux systèmes
 * séparés.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  REFERENTIELS_EMBARQUES,
  resoudreReferentiel,
  tauxPourCode,
  type Facture,
  type LigneFacture,
} from '@fneplus/core';
import { BaseDeDonnees, JETON_CONFIG, type TransactionSql } from '../db/db.module.js';
import type { Configuration } from '../config.js';
import { DgiClient, ErreurTransportDGI } from './dgi.client.js';
import { Disjoncteur, DisjoncteurOuvert } from './disjoncteur.js';
import { depuisReponseDGI, versFactureDGI, VERSION_MAPPING } from './anticorruption.js';

/** Nombre de tentatives avant de classer une transmission en échec définitif. */
const MAX_TENTATIVES = 20;

/**
 * Repli exponentiel borné à 15 minutes.
 *
 * Assez long pour ne pas marteler un service en difficulté, assez court pour
 * qu'une facture reparte vite quand la DGI revient. Les factures ont un délai
 * réglementaire : on ne peut pas attendre des heures par prudence.
 */
function delaiAvantReprise(tentatives: number): number {
  const base = Math.min(2 ** tentatives * 1_000, 15 * 60 * 1_000);
  return Math.round(base + Math.random() * base * 0.2);
}

export interface ResultatCycle {
  traitees: number;
  certifiees: number;
  rejetees: number;
  reportees: number;
  disjoncteurOuvert: boolean;
}

interface LigneFile {
  facture_id: string;
  entreprise_id: string;
  tentatives: number;
}

@Injectable()
export class TransmissionService {
  private readonly logger = new Logger(TransmissionService.name);
  private readonly disjoncteur: Disjoncteur;

  constructor(
    @Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees,
    @Inject(DgiClient) private readonly dgi: DgiClient,
    @Inject(JETON_CONFIG) config: Configuration,
  ) {
    this.disjoncteur = new Disjoncteur({
      seuilEchecs: config.DGI_SEUIL_DISJONCTEUR,
      dureeOuvertureMs: config.DGI_DUREE_OUVERTURE_MS,
    });
  }

  get etatDisjoncteur(): string {
    return this.disjoncteur.etat;
  }

  /* ------------------------------------------------------------------ */
  /* Mise en file                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Met une facture en file de transmission.
   *
   * Appelée dans la transaction qui enregistre la facture : une facture
   * enregistrée est forcément en file, et une entrée de file désigne forcément
   * une facture existante.
   */
  static mettreEnFile(tx: TransactionSql, factureId: string, entrepriseId: string): Promise<void> {
    return tx`
      INSERT INTO file_transmission (facture_id, entreprise_id, etat, prochaine_tentative_le)
      VALUES (${factureId}, ${entrepriseId}, 'EN_ATTENTE', now())
      ON CONFLICT (facture_id) DO NOTHING
    `.then(() => undefined);
  }

  /* ------------------------------------------------------------------ */
  /* Cycle de traitement                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Traite un lot de la file.
   *
   * Appelée périodiquement. Renvoie un compte-rendu plutôt que de lever : un
   * cycle qui échoue ne doit pas arrêter le suivant.
   */
  async traiterLot(taille = 20): Promise<ResultatCycle> {
    const resultat: ResultatCycle = {
      traitees: 0,
      certifiees: 0,
      rejetees: 0,
      reportees: 0,
      disjoncteurOuvert: false,
    };

    if (!this.disjoncteur.autorise()) {
      resultat.disjoncteurOuvert = true;
      return resultat;
    }

    // Le connecteur travaille pour toutes les entreprises : il n'a pas de
    // contexte tenant, et la RLS bloquerait une lecture directe. Une fonction
    // SECURITY DEFINER lui ouvre une porte étroite, qui ne rend que de quoi
    // choisir ses prochaines transmissions — jamais le contenu des factures.
    const aTraiter = await this.bdd.horsTenant(
      async (tx) => await tx<LigneFile[]>`SELECT * FROM fneplus_file_a_traiter(${taille})`,
    );

    for (const entree of aTraiter) {
      if (!this.disjoncteur.autorise()) {
        resultat.disjoncteurOuvert = true;
        break;
      }

      resultat.traitees++;
      const sort = await this.transmettreUne(entree);
      if (sort === 'CERTIFIEE') resultat.certifiees++;
      else if (sort === 'REJETEE') resultat.rejetees++;
      else resultat.reportees++;
    }

    return resultat;
  }

  private async transmettreUne(entree: LigneFile): Promise<'CERTIFIEE' | 'REJETEE' | 'REPORTEE'> {
    const contexte = await this.chargerFacture(entree.entreprise_id, entree.facture_id);
    if (!contexte) {
      // La facture a disparu : entrée de file orpheline, on la clôt plutôt que
      // de la réessayer indéfiniment.
      await this.marquerEchecDefinitif(entree, 'Facture introuvable.');
      return 'REJETEE';
    }

    const { facture, lignes, ncc } = contexte;
    const referentiel = resoudreReferentiel(facture.emiseLe, REFERENTIELS_EMBARQUES);
    const charge = versFactureDGI(facture, lignes, ncc, (code) =>
      tauxPourCode(referentiel, code as never),
    );

    try {
      const reponse = await this.disjoncteur.executer(() => this.dgi.transmettre(charge));
      const traduit = depuisReponseDGI(reponse);

      if (traduit.certifiee) {
        await this.marquerCertifiee(entree, traduit);
        return 'CERTIFIEE';
      }

      if (traduit.definitif) {
        await this.marquerRejetee(entree, traduit.messageUtilisateur ?? 'Refusée par la DGI.');
        return 'REJETEE';
      }

      // Rejet non définitif : la DGI a répondu, mais demande de réessayer. Ce
      // n'est pas une panne de transport, le disjoncteur n'est pas concerné.
      await this.reporter(entree, traduit.messageUtilisateur ?? 'Refus temporaire de la DGI.');
      return 'REPORTEE';
    } catch (erreur) {
      if (erreur instanceof DisjoncteurOuvert) {
        await this.reporter(entree, erreur.message);
        return 'REPORTEE';
      }

      if (erreur instanceof ErreurTransportDGI) {
        this.logger.warn(`Transmission ${facture.numero} reportée : ${erreur.message}`);
        await this.reporter(entree, erreur.message);
        return 'REPORTEE';
      }

      this.logger.error(`Erreur interne sur ${facture.numero} : ${String(erreur)}`);
      await this.reporter(entree, 'Erreur interne du connecteur.');
      return 'REPORTEE';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lecture et écritures                                                */
  /* ------------------------------------------------------------------ */

  private async chargerFacture(
    entrepriseId: string,
    factureId: string,
  ): Promise<{ facture: Facture; lignes: LigneFacture[]; ncc: string } | null> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [ligne] = await tx<
        {
          id: string;
          entreprise_id: string;
          point_de_vente_id: string;
          terminal_id: string;
          type: string;
          statut: string;
          numero: string;
          emise_le: Date;
          client_nom: string;
          client_ncc: string | null;
          totaux: Facture['totaux'];
          lignes: LigneFacture[];
          version_referentiel: string;
          hash_precedent: string;
          hash: string;
          ncc: string;
        }[]
      >`
        SELECT f.*, e.ncc
          FROM factures f JOIN entreprises e ON e.id = f.entreprise_id
         WHERE f.id = ${factureId}
      `;

      if (!ligne) return null;

      const facture: Facture = {
        id: ligne.id,
        entrepriseId: ligne.entreprise_id,
        pointDeVenteId: ligne.point_de_vente_id,
        terminalId: ligne.terminal_id,
        type: ligne.type as Facture['type'],
        statut: ligne.statut as Facture['statut'],
        numero: ligne.numero,
        emiseLe: ligne.emise_le.toISOString(),
        clientNom: ligne.client_nom,
        ...(ligne.client_ncc ? { clientNcc: ligne.client_ncc } : {}),
        lignes: ligne.lignes,
        totaux: ligne.totaux,
        versionReferentielFiscal: ligne.version_referentiel,
        hashPrecedent: ligne.hash_precedent,
        hash: ligne.hash,
      };

      return { facture, lignes: ligne.lignes, ncc: ligne.ncc };
    });
  }

  private async marquerCertifiee(
    entree: LigneFile,
    resultat: {
      identifiantCertification?: string;
      horodatageCertifie?: string;
      contenuQR?: string;
    },
  ): Promise<void> {
    await this.bdd.avecTenant(entree.entreprise_id, async (tx) => {
      await tx`
        UPDATE factures
           SET statut = 'CERTIFIEE',
               identifiant_dgi = ${resultat.identifiantCertification ?? null},
               horodatage_certifie = ${resultat.horodatageCertifie ?? new Date().toISOString()},
               -- Le QR n'est remplacé que si la DGI en fournit un : sinon on
               -- conserve celui remis au client.
               contenu_qr = COALESCE(${resultat.contenuQR ?? null}, contenu_qr),
               motif_rejet = NULL
         WHERE id = ${entree.facture_id}
      `;
      await tx`
        UPDATE file_transmission
           SET etat = 'CERTIFIEE', tentatives = tentatives + 1,
               terminee_le = now(), derniere_erreur = NULL,
               version_mapping = ${VERSION_MAPPING}
         WHERE facture_id = ${entree.facture_id}
      `;
    });
  }

  private async marquerRejetee(entree: LigneFile, message: string): Promise<void> {
    await this.bdd.avecTenant(entree.entreprise_id, async (tx) => {
      await tx`
        UPDATE factures SET statut = 'REJETEE', motif_rejet = ${message}
         WHERE id = ${entree.facture_id}
      `;
      await tx`
        UPDATE file_transmission
           SET etat = 'REJETEE', tentatives = tentatives + 1,
               terminee_le = now(), derniere_erreur = ${message},
               version_mapping = ${VERSION_MAPPING}
         WHERE facture_id = ${entree.facture_id}
      `;
    });
  }

  private async marquerEchecDefinitif(entree: LigneFile, message: string): Promise<void> {
    await this.bdd.horsTenant(async (tx) => {
      await tx`SELECT fneplus_file_marquer(${entree.facture_id}, ${'REJETEE'}, ${message})`;
    });
  }

  /**
   * Reporte une transmission.
   *
   * Au-delà de MAX_TENTATIVES, la facture n'est PAS abandonnée : elle passe en
   * attente d'intervention. Une pièce comptable ne se jette pas parce que le
   * réseau a été mauvais vingt fois.
   */
  private async reporter(entree: LigneFile, erreur: string): Promise<void> {
    const tentatives = entree.tentatives + 1;

    if (tentatives >= MAX_TENTATIVES) {
      await this.bdd.horsTenant(async (tx) => {
        await tx`
          SELECT fneplus_file_reporter(${entree.facture_id}, ${tentatives}, now(), ${erreur})
        `;
        await tx`
          SELECT fneplus_file_marquer(${entree.facture_id}, ${'INTERVENTION_REQUISE'}, ${erreur})
        `;
      });
      this.logger.error(
        `Facture ${entree.facture_id} en attente d'intervention après ${tentatives} tentatives.`,
      );
      return;
    }

    const prochaine = new Date(Date.now() + delaiAvantReprise(tentatives));
    await this.bdd.horsTenant(async (tx) => {
      await tx`
        SELECT fneplus_file_reporter(${entree.facture_id}, ${tentatives}, ${prochaine}, ${erreur})
      `;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Supervision                                                         */
  /* ------------------------------------------------------------------ */

  async etatFile(): Promise<Record<string, number>> {
    const lignes = await this.bdd.horsTenant(
      async (tx) => await tx<{ etat: string; n: number }[]>`SELECT * FROM fneplus_file_etat()`,
    );
    return Object.fromEntries(lignes.map((l) => [l.etat, Number(l.n)]));
  }

  /** Relance les transmissions en attente d'intervention, après correction. */
  async relancerInterventions(): Promise<number> {
    const [ligne] = await this.bdd.horsTenant(
      async (tx) =>
        await tx<{ fneplus_file_relancer_interventions: number }[]>`
          SELECT fneplus_file_relancer_interventions()
        `,
    );
    return ligne?.fneplus_file_relancer_interventions ?? 0;
  }
}
