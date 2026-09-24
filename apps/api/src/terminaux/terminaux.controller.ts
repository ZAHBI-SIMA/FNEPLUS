import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { TerminauxService } from './terminaux.service.js';
import { uuidSchema, ValidationZod } from '../commun/validation.js';
import { SessionCourante, type Session } from '../commun/auth.garde.js';

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
  allouerPlage(@SessionCourante() session: Session, @Param('terminalId') terminalId: string) {
    return this.terminaux.allouerPlage(session.entrepriseId, uuidSchema.parse(terminalId));
  }

  @Get(':terminalId/plages')
  listerPlages(@SessionCourante() session: Session, @Param('terminalId') terminalId: string) {
    return this.terminaux.listerPlages(session.entrepriseId, uuidSchema.parse(terminalId));
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
}
