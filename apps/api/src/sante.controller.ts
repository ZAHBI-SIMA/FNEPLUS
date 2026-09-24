import { Controller, Get, Inject } from '@nestjs/common';
import { BaseDeDonnees } from './db/db.module.js';
import { Publique } from './commun/auth.garde.js';

@Controller('api/v1')
export class SanteController {
  constructor(@Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees) {}

  /**
   * Sonde de disponibilité.
   *
   * Elle interroge réellement la base : un service qui répond « ok » alors que
   * sa base est injoignable fait croire à l'orchestrateur que tout va bien, et
   * laisse les terminaux se heurter à des erreurs.
   */
  @Publique()
  @Get('sante')
  async sante(): Promise<{ statut: string; base: string }> {
    try {
      await this.bdd.sql`SELECT 1`;
      return { statut: 'ok', base: 'ok' };
    } catch {
      return { statut: 'degrade', base: 'injoignable' };
    }
  }
}
