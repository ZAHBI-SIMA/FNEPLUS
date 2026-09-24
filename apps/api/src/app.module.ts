import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { EntreprisesController } from './entreprises/entreprises.controller.js';
import { EntreprisesService } from './entreprises/entreprises.service.js';
import { TerminauxController } from './terminaux/terminaux.controller.js';
import { TerminauxService } from './terminaux/terminaux.service.js';
import { SyncController } from './sync/sync.controller.js';
import { SyncService } from './sync/sync.service.js';
import { ReferentielsModule } from './referentiels/referentiels.controller.js';
import { GardeAuth } from './commun/auth.garde.js';
import { SanteController } from './sante.controller.js';

@Module({
  imports: [DbModule, AuthModule, ReferentielsModule],
  controllers: [
    SanteController,
    // AuthController est déclaré par AuthModule : le redéclarer ici ferait
    // enregistrer ses routes deux fois auprès de Fastify.
    EntreprisesController,
    TerminauxController,
    SyncController,
  ],
  providers: [
    EntreprisesService,
    TerminauxService,
    SyncService,
    // Authentification exigée par défaut sur toute la surface de l'API. Les
    // routes ouvertes sont marquées explicitement avec `@Publique()` : oublier
    // d'exiger un jeton devient impossible, seul l'inverse demande une action.
    { provide: APP_GUARD, useClass: GardeAuth },
  ],
})
export class AppModule {}
