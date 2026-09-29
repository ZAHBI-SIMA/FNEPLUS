/**
 * Appairage des terminaux et allocation des plages de numéros.
 *
 * C'est le service qui rend le hors-ligne possible : un terminal repart avec une
 * réserve de numéros qui n'appartient qu'à lui, et peut donc facturer des jours
 * durant sans réseau sans jamais entrer en collision avec une autre caisse.
 *
 * L'absence de chevauchement n'est pas garantie par ce code mais par une
 * contrainte d'exclusion GiST en base (migration 001). Deux allocations
 * simultanées pour le même point de vente ne peuvent pas produire deux plages
 * qui se recouvrent : la seconde échoue, et on réessaie.
 */

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@fneplus/core';
import { BaseDeDonnees, JETON_CONFIG, type TransactionSql } from '../db/db.module.js';
import type { Configuration } from '../config.js';

export interface TerminalAppaire {
  terminalId: string;
  libelle: string;
  pointDeVenteId: string;
}

export interface PlageAllouee {
  id: string;
  pointDeVenteId: string;
  prefixe: string;
  debut: number;
  fin: number;
  longueurCompteur: number;
  allouceLe: string;
}

export interface PointDeVenteAutorise {
  id: string;
  libelle: string;
  code: string;
  /** Point de vente fixé à l'appairage — celui qui ne peut jamais être retiré. */
  principal: boolean;
}

export interface TerminalResume {
  id: string;
  libelle: string;
  pointDeVenteId: string;
  pointDeVenteCode: string;
  revoque: boolean;
}

/** Nombre de reprises en cas de collision sur la contrainte d'exclusion. */
const MAX_REPRISES = 3;

@Injectable()
export class TerminauxService {
  constructor(
    @Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees,
    @Inject(JETON_CONFIG) private readonly config: Configuration,
  ) {}

  async appairer(
    entrepriseId: string,
    donnees: { pointDeVenteId: string; libelle: string; empreinte?: string },
  ): Promise<TerminalAppaire> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [pdv] = await tx<{ id: string }[]>`
        SELECT id FROM points_de_vente WHERE id = ${donnees.pointDeVenteId}
      `;
      if (!pdv) {
        throw new NotFoundException({
          code: 'POINT_DE_VENTE_INTROUVABLE',
          message: 'Ce point de vente n’existe pas.',
        });
      }

      // Un appareil qui se réinstalle retrouve son terminal plutôt que d'en
      // créer un nouveau : sans cela, chaque réinstallation consommerait une
      // plage de numéros et laisserait un trou de séquence à expliquer.
      if (donnees.empreinte) {
        const [existant] = await tx<{ id: string; libelle: string; point_de_vente_id: string }[]>`
          SELECT id, libelle, point_de_vente_id FROM terminaux
           WHERE empreinte = ${donnees.empreinte} AND revoque_le IS NULL
           LIMIT 1
        `;
        if (existant) {
          await tx`UPDATE terminaux SET vu_le = now() WHERE id = ${existant.id}`;
          return {
            terminalId: existant.id,
            libelle: existant.libelle,
            pointDeVenteId: existant.point_de_vente_id,
          };
        }
      }

      const terminalId = uuidv7();
      await tx`
        INSERT INTO terminaux (id, entreprise_id, point_de_vente_id, libelle, empreinte, vu_le)
        VALUES (${terminalId}, ${entrepriseId}, ${donnees.pointDeVenteId},
                ${donnees.libelle}, ${donnees.empreinte ?? null}, now())
      `;

      return {
        terminalId,
        libelle: donnees.libelle,
        pointDeVenteId: donnees.pointDeVenteId,
      };
    });
  }

  /**
   * Alloue une nouvelle plage de numéros à un terminal.
   *
   * Le préfixe inclut le code du point de vente et l'année : une plage ne
   * traverse jamais un exercice fiscal, ce qui garde les séquences annuelles
   * lisibles lors d'un contrôle.
   */
  async allouerPlage(
    entrepriseId: string,
    terminalId: string,
    taille = this.config.TAILLE_PLAGE_NUMEROS,
    pointDeVenteCibleId?: string,
  ): Promise<PlageAllouee> {
    for (let tentative = 0; tentative < MAX_REPRISES; tentative++) {
      try {
        return await this.bdd.avecTenant(entrepriseId, (tx) =>
          this.allouerDansTransaction(tx, entrepriseId, terminalId, taille, pointDeVenteCibleId),
        );
      } catch (erreur) {
        // 23P01 = violation de contrainte d'exclusion : une autre allocation a
        // pris la même plage entre notre lecture et notre écriture. On relit et
        // on recommence — c'est exactement le rôle de cette contrainte.
        const code = (erreur as { code?: string }).code;
        if (code !== '23P01' || tentative === MAX_REPRISES - 1) throw erreur;
      }
    }

    throw new ConflictException({
      code: 'ALLOCATION_IMPOSSIBLE',
      message: 'Impossible d’allouer une réserve de numéros. Réessayez.',
    });
  }

  private async allouerDansTransaction(
    tx: TransactionSql,
    entrepriseId: string,
    terminalId: string,
    taille: number,
    pointDeVenteCibleId?: string,
  ): Promise<PlageAllouee> {
    const [terminal] = await tx<{ point_de_vente_id: string; revoque_le: Date | null }[]>`
      SELECT point_de_vente_id, revoque_le FROM terminaux WHERE id = ${terminalId}
    `;

    if (!terminal) {
      throw new NotFoundException({
        code: 'TERMINAL_INTROUVABLE',
        message: 'Ce terminal n’est pas rattaché à votre entreprise.',
      });
    }
    if (terminal.revoque_le) {
      throw new ConflictException({
        code: 'TERMINAL_REVOQUE',
        message: 'Cet appareil a été révoqué. Contactez le responsable du compte.',
      });
    }

    // Par défaut, la plage sert le point de vente principal du terminal — le
    // seul cas jusqu'ici, et le comportement reste identique. Un point de
    // vente cible différent (sélecteur rapide en caisse) doit avoir été
    // explicitement autorisé pour ce terminal.
    const pointDeVenteId = pointDeVenteCibleId ?? terminal.point_de_vente_id;

    if (pointDeVenteId !== terminal.point_de_vente_id) {
      const [autorise] = await tx<{ point_de_vente_id: string }[]>`
        SELECT point_de_vente_id FROM terminaux_points_de_vente
         WHERE terminal_id = ${terminalId} AND point_de_vente_id = ${pointDeVenteId}
      `;
      if (!autorise) {
        throw new ConflictException({
          code: 'POINT_DE_VENTE_NON_AUTORISE',
          message: 'Ce terminal n’est pas autorisé à facturer pour ce point de vente.',
        });
      }
    }

    const [pdv] = await tx<{ code: string }[]>`
      SELECT code FROM points_de_vente WHERE id = ${pointDeVenteId}
    `;

    const prefixe = `${pdv?.code ?? 'PDV01'}-${new Date().getFullYear()}`;

    const [borne] = await tx<{ maximum: number | null }[]>`
      SELECT MAX(fin) AS maximum FROM plages_numeros
       WHERE point_de_vente_id = ${pointDeVenteId} AND prefixe = ${prefixe}
    `;

    const debut = (borne?.maximum ?? 0) + 1;
    const fin = debut + taille - 1;
    const id = uuidv7();

    const [plage] = await tx<{ allouee_le: Date }[]>`
      INSERT INTO plages_numeros (
        id, entreprise_id, point_de_vente_id, terminal_id, prefixe, debut, fin, longueur_compteur
      ) VALUES (
        ${id}, ${entrepriseId}, ${pointDeVenteId}, ${terminalId},
        ${prefixe}, ${debut}, ${fin}, ${6}
      )
      RETURNING allouee_le
    `;

    return {
      id,
      pointDeVenteId,
      prefixe,
      debut,
      fin,
      longueurCompteur: 6,
      allouceLe: (plage?.allouee_le ?? new Date()).toISOString(),
    };
  }

  /**
   * Clôture une plage entamée.
   *
   * Les numéros non consommés sont déclarés : un trou de séquence expliqué et
   * journalisé est défendable lors d'un contrôle, un trou inexpliqué ne l'est pas.
   */
  async cloturerPlage(
    entrepriseId: string,
    plageId: string,
    numerosNonUtilises: number,
  ): Promise<void> {
    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        UPDATE plages_numeros
           SET cloturee_le = now(), numeros_non_utilises = ${numerosNonUtilises}
         WHERE id = ${plageId} AND cloturee_le IS NULL
      `;
    });
  }

  async listerPlages(
    entrepriseId: string,
    terminalId: string,
    pointDeVenteId?: string,
  ): Promise<PlageAllouee[]> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const lignes = await tx<
        {
          id: string;
          point_de_vente_id: string;
          prefixe: string;
          debut: number;
          fin: number;
          longueur_compteur: number;
          allouee_le: Date;
        }[]
      >`
        SELECT id, point_de_vente_id, prefixe, debut, fin, longueur_compteur, allouee_le
          FROM plages_numeros
         WHERE terminal_id = ${terminalId} AND cloturee_le IS NULL
           AND (${pointDeVenteId ?? null}::uuid IS NULL
                OR point_de_vente_id = ${pointDeVenteId ?? null}::uuid)
         ORDER BY allouee_le ASC
      `;

      return lignes.map((l) => ({
        id: l.id,
        pointDeVenteId: l.point_de_vente_id,
        prefixe: l.prefixe,
        debut: l.debut,
        fin: l.fin,
        longueurCompteur: l.longueur_compteur,
        allouceLe: l.allouee_le.toISOString(),
      }));
    });
  }

  /**
   * Autorise un terminal à facturer aussi au nom d'un autre point de vente
   * que son point de vente principal (sélecteur rapide en caisse). N'affecte
   * jamais le point de vente principal ni ses plages existantes — la garantie
   * de non-collision de la séquence n'est donc jamais mise en jeu pour un
   * terminal qui n'utilise pas cette fonctionnalité.
   */
  async autoriserPointDeVente(
    entrepriseId: string,
    terminalId: string,
    pointDeVenteId: string,
  ): Promise<void> {
    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [terminal] = await tx<{ id: string }[]>`
        SELECT id FROM terminaux WHERE id = ${terminalId}
      `;
      if (!terminal) {
        throw new NotFoundException({
          code: 'TERMINAL_INTROUVABLE',
          message: 'Ce terminal n’est pas rattaché à votre entreprise.',
        });
      }

      const [pdv] = await tx<{ id: string }[]>`
        SELECT id FROM points_de_vente WHERE id = ${pointDeVenteId}
      `;
      if (!pdv) {
        throw new NotFoundException({
          code: 'POINT_DE_VENTE_INTROUVABLE',
          message: 'Ce point de vente n’existe pas.',
        });
      }

      await tx`
        INSERT INTO terminaux_points_de_vente (entreprise_id, terminal_id, point_de_vente_id)
        VALUES (${entrepriseId}, ${terminalId}, ${pointDeVenteId})
        ON CONFLICT (terminal_id, point_de_vente_id) DO NOTHING
      `;
    });
  }

  /** Terminaux de l'entreprise — sert au propriétaire pour choisir qui autoriser sur quel point de vente. */
  async listerTerminaux(entrepriseId: string): Promise<TerminalResume[]> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const lignes = await tx<
        { id: string; libelle: string; point_de_vente_id: string; code: string; revoque_le: Date | null }[]
      >`
        SELECT t.id, t.libelle, t.point_de_vente_id, pdv.code, t.revoque_le
          FROM terminaux t
          JOIN points_de_vente pdv ON pdv.id = t.point_de_vente_id
         WHERE t.entreprise_id = ${entrepriseId}
         ORDER BY t.appaire_le ASC
      `;
      return lignes.map((l) => ({
        id: l.id,
        libelle: l.libelle,
        pointDeVenteId: l.point_de_vente_id,
        pointDeVenteCode: l.code,
        revoque: l.revoque_le !== null,
      }));
    });
  }

  /** Points de vente qu'un terminal peut facturer : le principal, puis ceux autorisés en plus. */
  async listerPointsDeVenteAutorises(
    entrepriseId: string,
    terminalId: string,
  ): Promise<PointDeVenteAutorise[]> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [terminal] = await tx<{ point_de_vente_id: string }[]>`
        SELECT point_de_vente_id FROM terminaux WHERE id = ${terminalId}
      `;
      if (!terminal) {
        throw new NotFoundException({
          code: 'TERMINAL_INTROUVABLE',
          message: 'Ce terminal n’est pas rattaché à votre entreprise.',
        });
      }

      const lignes = await tx<{ id: string; libelle: string; code: string }[]>`
        SELECT pdv.id, pdv.libelle, pdv.code
          FROM points_de_vente pdv
         WHERE pdv.id = ${terminal.point_de_vente_id}
            OR pdv.id IN (
                 SELECT point_de_vente_id FROM terminaux_points_de_vente
                  WHERE terminal_id = ${terminalId}
               )
         ORDER BY pdv.code
      `;

      return lignes.map((l) => ({ ...l, principal: l.id === terminal.point_de_vente_id }));
    });
  }
}
