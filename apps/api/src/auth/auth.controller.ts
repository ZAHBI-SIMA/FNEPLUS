import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type ResultatConnexion } from './auth.service.js';
import { pinSchema, telephoneIvoirien, ValidationZod } from '../commun/validation.js';
import { Publique, SessionCourante, type Session } from '../commun/auth.garde.js';

const demandeCodeSchema = z.object({ telephone: telephoneIvoirien });
const verificationSchema = z.object({
  telephone: telephoneIvoirien,
  code: z.string().regex(/^[0-9]{6}$/, 'Le code comporte 6 chiffres.'),
});
const connexionPinSchema = z.object({ telephone: telephoneIvoirien, pin: pinSchema });
const definitionPinSchema = z.object({ pin: pinSchema });

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Publique()
  @Post('demander-code')
  @HttpCode(HttpStatus.ACCEPTED)
  async demanderCode(
    @Body(new ValidationZod(demandeCodeSchema)) corps: z.infer<typeof demandeCodeSchema>,
  ): Promise<{ message: string }> {
    await this.auth.demanderCode(corps.telephone);

    // Réponse identique que le numéro existe ou non : le client ne doit pas
    // pouvoir servir à énumérer les commerçants inscrits.
    return {
      message: 'Si ce numéro correspond à un compte, un code vient d’être envoyé par SMS.',
    };
  }

  @Publique()
  @Post('verifier-code')
  @HttpCode(HttpStatus.OK)
  verifierCode(
    @Body(new ValidationZod(verificationSchema)) corps: z.infer<typeof verificationSchema>,
  ): Promise<ResultatConnexion> {
    return this.auth.verifierCode(corps.telephone, corps.code);
  }

  @Publique()
  @Post('connexion-pin')
  @HttpCode(HttpStatus.OK)
  connexionPin(
    @Body(new ValidationZod(connexionPinSchema)) corps: z.infer<typeof connexionPinSchema>,
  ): Promise<ResultatConnexion> {
    return this.auth.connecterParPin(corps.telephone, corps.pin);
  }

  @Post('definir-pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async definirPin(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(definitionPinSchema)) corps: z.infer<typeof definitionPinSchema>,
  ): Promise<void> {
    await this.auth.definirPin(session, corps.pin);
  }
}
