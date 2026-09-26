/**
 * Encaissement mobile money.
 *
 * Le webhook est marqué `@Publique()` : le prestataire de paiement ne porte pas
 * de jeton FNE+, il porte une signature HMAC vérifiée par le service lui-même.
 * C'est cette vérification — pas le garde d'authentification — qui protège la
 * route.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PaiementsService } from './paiements.service.js';
import { AgregateurClient } from './agregateur.client.js';
import { uuidSchema, ValidationZod } from '../commun/validation.js';
import { Publique, SessionCourante, type Session } from '../commun/auth.garde.js';

const MOYENS = [
  'ESPECES',
  'ORANGE_MONEY',
  'MTN_MOMO',
  'WAVE',
  'MOOV_MONEY',
  'VIREMENT',
  'AUTRE',
] as const;

const encaissementSchema = z.object({
  factureId: uuidSchema,
  moyen: z.enum(MOYENS),
  montant: z.number().int().positive(),
  telephone: z.string().trim().max(20).optional(),
});

@Controller('api/v1/paiements')
export class PaiementsController {
  constructor(@Inject(PaiementsService) private readonly paiements: PaiementsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  encaisser(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(encaissementSchema)) corps: z.infer<typeof encaissementSchema>,
  ) {
    return this.paiements.encaisser(session.entrepriseId, corps);
  }

  @Get('factures/:factureId')
  etatReglement(@SessionCourante() session: Session, @Param('factureId') factureId: string) {
    return this.paiements.etatReglement(session.entrepriseId, uuidSchema.parse(factureId));
  }

  /**
   * Webhook du prestataire de paiement.
   *
   * Le corps est lu en octets bruts (`request.rawBody`, activé dans
   * `main.ts`) : la vérification de signature HMAC porte sur exactement ce que
   * le prestataire a envoyé. Un corps reconstruit après désérialisation JSON
   * (ordre des clés, espacement) ne redonnerait pas la même signature.
   */
  @Publique()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Req() requete: FastifyRequest & { rawBody?: string | Buffer },
    @Headers('x-momo-signature') signature: string | undefined,
  ) {
    const texte = (requete.rawBody ?? JSON.stringify(requete.body ?? {})).toString('utf8');
    return this.paiements.traiterNotification(texte, signature);
  }
}

@Module({
  controllers: [PaiementsController],
  providers: [PaiementsService, AgregateurClient],
  exports: [PaiementsService],
})
export class PaiementsModule {}
