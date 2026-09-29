import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { TerminauxService } from './terminaux.service.js';
import { uuidSchema, ValidationZod } from '../commun/validation.js';
import { Roles, SessionCourante, type Session } from '../commun/auth.garde.js';

const appairageSchema = z.object({
  pointDeVenteId: uuidSchema,
  libelle: z.string().trim().min(1, 'Donnez un nom à cet appareil.').max(120),
  /** Empreinte stable de l'appareil, générée et conservée par la PWA. */
  empreinte: z.string().trim().max(200).optional(),
});

const clotureSchema = z.object({
  plageId: uuidSchema,
  numerosNonUtilises: z.number().int().min(0),
});

// Corps facultatif : par défaut, la plage sert le point de vente principal du
// terminal (comportement historique, inchangé). Un pointDeVenteId différent
// sert le sélecteur rapide en caisse, pour un point de vente autorisé en plus.
const allouerPlageSchema = z.object({ pointDeVenteId: uuidSchema.optional() }).default({});

const autoriserPdvSchema = z.object({ pointDeVenteId: uuidSchema });

@Controller('api/v1/terminaux')
export class TerminauxController {
  constructor(@Inject(TerminauxService) private readonly terminaux: TerminauxService) {}

  @Post('appairage')
  @HttpCode(HttpStatus.CREATED)
  appairer(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(appairageSchema)) corps: z.infer<typeof appairageSchema>,
  ) {
    return this.terminaux.appairer(session.entrepriseId, corps);
  }

  @Post(':terminalId/plages')
  @HttpCode(HttpStatus.CREATED)
  allouerPlage(
    @SessionCourante() session: Session,
    @Param('terminalId') terminalId: string,
    @Body(new ValidationZod(allouerPlageSchema)) corps: z.infer<typeof allouerPlageSchema>,
  ) {
    return this.terminaux.allouerPlage(
      session.entrepriseId,
      uuidSchema.parse(terminalId),
      undefined,
      corps.pointDeVenteId,
    );
  }

  @Get(':terminalId/plages')
  listerPlages(
    @SessionCourante() session: Session,
    @Param('terminalId') terminalId: string,
    @Query('pointDeVenteId') pointDeVenteId?: string,
  ) {
    return this.terminaux.listerPlages(
      session.entrepriseId,
      uuidSchema.parse(terminalId),
      pointDeVenteId ? uuidSchema.parse(pointDeVenteId) : undefined,
    );
  }

  @Post('plages/cloture')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cloturerPlage(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(clotureSchema)) corps: z.infer<typeof clotureSchema>,
  ): Promise<void> {
    await this.terminaux.cloturerPlage(
      session.entrepriseId,
      corps.plageId,
      corps.numerosNonUtilises,
    );
  }

  // Autoriser un terminal pour un point de vente supplémentaire engage la
  // numérotation de ce point de vente : seul le propriétaire en décide.
  @Roles('PROPRIETAIRE')
  @Post(':terminalId/points-de-vente-autorises')
  @HttpCode(HttpStatus.NO_CONTENT)
  async autoriserPointDeVente(
    @SessionCourante() session: Session,
    @Param('terminalId') terminalId: string,
    @Body(new ValidationZod(autoriserPdvSchema)) corps: z.infer<typeof autoriserPdvSchema>,
  ): Promise<void> {
    await this.terminaux.autoriserPointDeVente(
      session.entrepriseId,
      uuidSchema.parse(terminalId),
      corps.pointDeVenteId,
    );
  }

  @Get(':terminalId/points-de-vente-autorises')
  listerPointsDeVenteAutorises(
    @SessionCourante() session: Session,
    @Param('terminalId') terminalId: string,
  ) {
    return this.terminaux.listerPointsDeVenteAutorises(
      session.entrepriseId,
      uuidSchema.parse(terminalId),
    );
  }

  // Réservé au propriétaire : la liste sert à choisir quel appareil autoriser
  // sur quel point de vente supplémentaire, une décision qui l'engage.
  @Roles('PROPRIETAIRE')
  @Get()
  listerTerminaux(@SessionCourante() session: Session) {
    return this.terminaux.listerTerminaux(session.entrepriseId);
  }
}
