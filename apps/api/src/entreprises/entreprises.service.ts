/**
 * Inscription et structure de l'entreprise.
 *
 * L'inscription crée d'un coup l'entreprise, son premier point de vente et son
 * utilisateur propriétaire. C'est volontaire : demander au commerçant de créer
 * trois objets successifs avant de pouvoir facturer est le meilleur moyen de le
 * perdre en route. Le point de vente unique est le cas de très loin le plus
 * fréquent, et il reste modifiable ensuite.
 */

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7, type RegimeFiscal } from '@fneplus/core';
import { BaseDeDonnees } from '../db/db.module.js';
import type { RoleUtilisateur } from '../commun/auth.garde.js';

export interface DemandeInscription {
  ncc: string;
  raisonSociale: string;
  regimeFiscal: RegimeFiscal;
  telephone: string;
  adresse?: string;
  email?: string;
  nomProprietaire: string;
  /** Libellé du premier point de vente. Par défaut « Boutique principale ». */
  libellePointDeVente?: string;
}

export interface ResultatInscription {
  entrepriseId: string;
  pointDeVenteId: string;
  utilisateurId: string;
}

export interface EntrepriseComplete {
  id: string;
  ncc: string;
  raisonSociale: string;
  regimeFiscal: RegimeFiscal;
  adresse: string;
  telephone: string;
  email: string | null;
  pointsDeVente: { id: string; libelle: string; code: string; adresse: string | null }[];
}

@Injectable()
export class EntreprisesService {
  constructor(@Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees) {}

  async inscrire(demande: DemandeInscription): Promise<ResultatInscription> {
    const entrepriseId = uuidv7();
    const pointDeVenteId = uuidv7();
    const utilisateurId = uuidv7();

    // Contrôles d'unicité avant d'ouvrir le contexte tenant : à cet instant
    // l'entreprise n'existe pas encore, donc la RLS empêcherait toute lecture.
    await this.bdd.horsTenant(async (tx) => {
      const [existe] = await tx<{ fneplus_ncc_existe: boolean }[]>`
        SELECT fneplus_ncc_existe(${demande.ncc})
      `;
      if (existe?.fneplus_ncc_existe) {
        throw new ConflictException({
          code: 'NCC_DEJA_INSCRIT',
          message: 'Ce numéro de compte contribuable est déjà associé à un compte FNE+.',
        });
      }

      const compte = await tx<{ utilisateur_id: string }[]>`
        SELECT * FROM fneplus_resoudre_compte(${demande.telephone})
      `;
      if (compte.length > 0) {
        throw new ConflictException({
          code: 'TELEPHONE_DEJA_INSCRIT',
          message: 'Ce numéro est déjà utilisé par un compte. Connectez-vous plutôt.',
        });
      }
    });

    // Le contexte tenant est posé sur l'identifiant qu'on s'apprête à créer :
    // la politique `WITH CHECK (id = entreprise courante)` valide alors
    // l'insertion, et rien d'autre ne peut être écrit dans cette transaction.
    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        INSERT INTO entreprises (id, ncc, raison_sociale, regime_fiscal, adresse, telephone, email)
        VALUES (${entrepriseId}, ${demande.ncc}, ${demande.raisonSociale},
                ${demande.regimeFiscal}, ${demande.adresse ?? ''}, ${demande.telephone},
                ${demande.email ?? null})
      `;

      await tx`
        INSERT INTO points_de_vente (id, entreprise_id, libelle, code, adresse)
        VALUES (${pointDeVenteId}, ${entrepriseId},
                ${demande.libellePointDeVente ?? 'Boutique principale'},
                ${'PDV01'}, ${demande.adresse ?? null})
      `;

      await tx`
        INSERT INTO utilisateurs (id, entreprise_id, telephone, nom, role)
        VALUES (${utilisateurId}, ${entrepriseId}, ${demande.telephone},
                ${demande.nomProprietaire}, ${'PROPRIETAIRE'})
      `;
    });

    return { entrepriseId, pointDeVenteId, utilisateurId };
  }

  async lire(entrepriseId: string): Promise<EntrepriseComplete> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [entreprise] = await tx<
        {
          id: string;
          ncc: string;
          raison_sociale: string;
          regime_fiscal: RegimeFiscal;
          adresse: string;
          telephone: string;
          email: string | null;
        }[]
      >`SELECT id, ncc, raison_sociale, regime_fiscal, adresse, telephone, email
          FROM entreprises WHERE id = ${entrepriseId}`;

      if (!entreprise) {
        throw new NotFoundException({
          code: 'ENTREPRISE_INTROUVABLE',
          message: 'Entreprise introuvable.',
        });
      }

      const pointsDeVente = await tx<
        { id: string; libelle: string; code: string; adresse: string | null }[]
      >`SELECT id, libelle, code, adresse FROM points_de_vente
         WHERE entreprise_id = ${entrepriseId} ORDER BY code`;

      return {
        id: entreprise.id,
        ncc: entreprise.ncc,
        raisonSociale: entreprise.raison_sociale,
        regimeFiscal: entreprise.regime_fiscal,
        adresse: entreprise.adresse,
        telephone: entreprise.telephone,
        email: entreprise.email,
        pointsDeVente,
      };
    });
  }

  async ajouterUtilisateur(
    entrepriseId: string,
    donnees: { telephone: string; nom: string; role: RoleUtilisateur },
  ): Promise<{ utilisateurId: string }> {
    const utilisateurId = uuidv7();

    const dejaPris = await this.bdd.horsTenant(async (tx) => {
      const lignes = await tx`SELECT * FROM fneplus_resoudre_compte(${donnees.telephone})`;
      return lignes.length > 0;
    });

    if (dejaPris) {
      throw new ConflictException({
        code: 'TELEPHONE_DEJA_INSCRIT',
        message: 'Ce numéro est déjà rattaché à un compte.',
      });
    }

    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        INSERT INTO utilisateurs (id, entreprise_id, telephone, nom, role)
        VALUES (${utilisateurId}, ${entrepriseId}, ${donnees.telephone},
                ${donnees.nom}, ${donnees.role})
      `;
    });

    return { utilisateurId };
  }
}
