/**
 * Suivi de l'Attestation de Régularité Fiscale.
 *
 * Exigence du cahier des charges : « tableau de bord affichant en permanence si
 * l'entreprise est en règle vis-à-vis de l'ARF, avec alerte avant toute rupture
 * de conformité qui bloquerait l'accès aux marchés publics ».
 *
 * Deux mots comptent dans cette phrase : « en permanence » et « avant ». Le
 * premier écarte un simple champ affiché une fois sur un écran qu'on n'ouvre
 * jamais ; le second écarte une alerte envoyée le jour même de l'expiration —
 * une entreprise qui répond à un appel d'offres a besoin de savoir plusieurs
 * jours à l'avance, pas le matin de l'échéance.
 *
 * ⚠️ La saisie de l'ARF est manuelle pour l'instant : aucune interconnexion avec
 * le système de délivrance de la DGI n'existe. C'est le propriétaire ou le
 * comptable qui enregistre son attestation. Une intégration automatique reste à
 * étudier une fois l'accès à un service DGI pertinent confirmé.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { uuidv7 } from '@fneplus/core';
import { BaseDeDonnees } from '../db/db.module.js';
import { Roles, SessionCourante, type Session } from '../commun/auth.garde.js';
import { ValidationZod } from '../commun/validation.js';

/** Fenêtre d'alerte avant expiration : assez tôt pour renouveler avant un appel d'offres. */
const JOURS_ALERTE_AVANT_EXPIRATION = 30;

export type StatutARF = 'A_JOUR' | 'BIENTOT_EXPIREE' | 'EXPIREE' | 'AUCUNE' | 'REVOQUEE';

export interface SituationARF {
  statut: StatutARF;
  numero?: string;
  delivreeLe?: string;
  expireLe?: string;
  joursAvantExpiration?: number;
  message: string;
}

const LIBELLES: Record<StatutARF, (jours?: number) => string> = {
  A_JOUR: () => 'Votre entreprise est en règle vis-à-vis de l’ARF.',
  BIENTOT_EXPIREE: (j) =>
    `Votre attestation expire dans ${j} jour${j! > 1 ? 's' : ''}. Renouvelez-la avant l’échéance pour ne pas perdre l’accès aux marchés publics.`,
  EXPIREE: () =>
    'Votre attestation de régularité fiscale a expiré. L’accès aux marchés publics est bloqué jusqu’au renouvellement.',
  REVOQUEE: () => 'Votre attestation a été révoquée par l’administration. Contactez la DGI.',
  AUCUNE: () => 'Aucune attestation de régularité fiscale enregistrée.',
};

@Injectable()
export class ArfService {
  constructor(@Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees) {}

  async situation(entrepriseId: string): Promise<SituationARF> {
    const attestation = await this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [a] = await tx<
        {
          numero: string | null;
          delivree_le: Date;
          expire_le: Date;
          revoquee_le: Date | null;
        }[]
      >`
        SELECT numero, delivree_le, expire_le, revoquee_le FROM attestations_arf
         WHERE entreprise_id = ${entrepriseId}
         ORDER BY expire_le DESC
         LIMIT 1
      `;
      return a;
    });

    if (!attestation) {
      return { statut: 'AUCUNE', message: LIBELLES.AUCUNE() };
    }

    if (attestation.revoquee_le) {
      return {
        statut: 'REVOQUEE',
        ...(attestation.numero ? { numero: attestation.numero } : {}),
        delivreeLe: attestation.delivree_le.toISOString(),
        expireLe: attestation.expire_le.toISOString(),
        message: LIBELLES.REVOQUEE(),
      };
    }

    const maintenant = Date.now();
    const joursAvantExpiration = Math.ceil(
      (attestation.expire_le.getTime() - maintenant) / 86_400_000,
    );

    const base = {
      ...(attestation.numero ? { numero: attestation.numero } : {}),
      delivreeLe: attestation.delivree_le.toISOString(),
      expireLe: attestation.expire_le.toISOString(),
      joursAvantExpiration,
    };

    if (joursAvantExpiration < 0) {
      return { statut: 'EXPIREE', ...base, message: LIBELLES.EXPIREE() };
    }
    if (joursAvantExpiration <= JOURS_ALERTE_AVANT_EXPIRATION) {
      return {
        statut: 'BIENTOT_EXPIREE',
        ...base,
        message: LIBELLES.BIENTOT_EXPIREE(joursAvantExpiration),
      };
    }
    return { statut: 'A_JOUR', ...base, message: LIBELLES.A_JOUR() };
  }

  async enregistrer(
    entrepriseId: string,
    donnees: { numero?: string; delivreeLe: string; expireLe: string },
  ): Promise<{ id: string }> {
    const id = uuidv7();
    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        INSERT INTO attestations_arf (id, entreprise_id, numero, delivree_le, expire_le)
        VALUES (${id}, ${entrepriseId}, ${donnees.numero ?? null}, ${donnees.delivreeLe}, ${donnees.expireLe})
      `;
    });
    return { id };
  }

  /** Révoque l'attestation en cours, quand l'administration la retire avant terme. */
  async revoquer(entrepriseId: string, motif: string): Promise<void> {
    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        UPDATE attestations_arf
           SET revoquee_le = CURRENT_DATE, motif_revocation = ${motif}
         WHERE entreprise_id = ${entrepriseId}
           AND id = (
             SELECT id FROM attestations_arf
              WHERE entreprise_id = ${entrepriseId} AND revoquee_le IS NULL
              ORDER BY expire_le DESC LIMIT 1
           )
      `;
    });
  }
}

const inscriptionSchema = z.object({
  numero: z.string().trim().max(60).optional(),
  delivreeLe: z.string(),
  expireLe: z.string(),
});

@Controller('api/v1/arf')
export class ArfController {
  constructor(@Inject(ArfService) private readonly arf: ArfService) {}

  @Get('situation')
  situation(@SessionCourante() session: Session) {
    return this.arf.situation(session.entrepriseId);
  }

  @Roles('PROPRIETAIRE', 'COMPTABLE')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  enregistrer(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(inscriptionSchema)) corps: z.infer<typeof inscriptionSchema>,
  ) {
    return this.arf.enregistrer(session.entrepriseId, corps);
  }
}

@Module({
  controllers: [ArfController],
  providers: [ArfService],
  exports: [ArfService],
})
export class ArfModule {}
