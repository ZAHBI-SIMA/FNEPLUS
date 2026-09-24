/**
 * Référentiel fiscal servi aux terminaux.
 *
 * Les terminaux le mettent en cache local : c'est ce qui leur permet de calculer
 * une TVA juste alors qu'ils sont déconnectés. Une mise à jour de taux publiée
 * ici se propage donc à chaque terminal à sa prochaine connexion, sans
 * intervention du commerçant ni déploiement applicatif — c'est l'exigence de
 * veille réglementaire du cahier des charges.
 */

import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { REFERENTIELS_EMBARQUES, type VersionReferentielFiscal } from '@fneplus/core';
import { BaseDeDonnees } from '../db/db.module.js';
import { Publique } from '../commun/auth.garde.js';

@Injectable()
export class ReferentielsService {
  constructor(@Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees) {}

  async lister(): Promise<VersionReferentielFiscal[]> {
    const lignes = await this.bdd.horsTenant(
      async (tx) =>
        await tx<{ contenu: VersionReferentielFiscal }[]>`
          SELECT contenu FROM referentiels_fiscaux ORDER BY date_effet ASC
        `,
    );

    // Repli sur les versions embarquées tant que la table n'est pas alimentée :
    // un terminal neuf doit pouvoir calculer une TVA dès sa première ouverture,
    // même si la publication du référentiel n'a pas encore eu lieu.
    return lignes.length > 0 ? lignes.map((l) => l.contenu) : REFERENTIELS_EMBARQUES;
  }
}

@Controller('api/v1/referentiels')
export class ReferentielsController {
  constructor(@Inject(ReferentielsService) private readonly referentiels: ReferentielsService) {}

  @Publique()
  @Get('fiscaux')
  lister(): Promise<VersionReferentielFiscal[]> {
    return this.referentiels.lister();
  }
}

@Module({
  controllers: [ReferentielsController],
  providers: [ReferentielsService],
  exports: [ReferentielsService],
})
export class ReferentielsModule {}
