/**
 * Connecteur DGI et archivage.
 *
 * Regroupés dans un module isolé du reste de l'API : leurs pannes ne doivent pas
 * empêcher les terminaux de se synchroniser. Un commerçant doit pouvoir
 * continuer à facturer et à pousser ses factures même si l'administration est
 * injoignable depuis des heures.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
  Query,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { z } from 'zod';
import { DgiClient } from './dgi.client.js';
import { TransmissionService } from './transmission.service.js';
import { ArchivageService } from '../archivage/archivage.service.js';
import { ValidationZod } from '../commun/validation.js';
import { Publique, Roles, SessionCourante, type Session } from '../commun/auth.garde.js';

/** Intervalle entre deux cycles de traitement de la file. */
const INTERVALLE_CYCLE_MS = 5_000;

/**
 * Ordonnanceur du connecteur.
 *
 * Boucle simple plutôt qu'une file Redis : la file est déjà dans PostgreSQL, et
 * c'est elle qui garantit la livraison. L'ordonnanceur ne fait que déclencher
 * des cycles — le perdre ne perd aucune facture, il repart au redémarrage.
 */
@Injectable()
export class OrdonnanceurTransmission implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrdonnanceurTransmission.name);
  private minuteur: NodeJS.Timeout | null = null;
  private cycleEnCours = false;

  constructor(@Inject(TransmissionService) private readonly transmission: TransmissionService) {}

  onApplicationBootstrap(): void {
    if (process.env['NODE_ENV'] === 'test' || process.env['FNE_SANS_ORDONNANCEUR'] === '1') {
      this.logger.log('Ordonnanceur désactivé (tests).');
      return;
    }
    this.minuteur = setInterval(() => void this.cycle(), INTERVALLE_CYCLE_MS);
    this.logger.log(`Connecteur DGI actif, cycle toutes les ${INTERVALLE_CYCLE_MS / 1000} s.`);
  }

  onApplicationShutdown(): void {
    if (this.minuteur) clearInterval(this.minuteur);
  }

  private async cycle(): Promise<void> {
    // Un cycle qui déborde ne doit pas en déclencher un second en parallèle :
    // deux cycles concurrents transmettraient les mêmes factures.
    if (this.cycleEnCours) return;
    this.cycleEnCours = true;

    try {
      const resultat = await this.transmission.traiterLot();
      if (resultat.traitees > 0) {
        this.logger.log(
          `Cycle : ${resultat.certifiees} certifiées, ${resultat.rejetees} rejetées, ${resultat.reportees} reportées.`,
        );
      }
    } catch (erreur) {
      this.logger.error(`Cycle en échec : ${String(erreur)}`);
    } finally {
      this.cycleEnCours = false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Contrôleurs                                                         */
/* ------------------------------------------------------------------ */

const periodeSchema = z.object({
  debut: z.string(),
  fin: z.string(),
});

const exportSchema = periodeSchema.extend({
  motif: z.string().trim().max(500).optional(),
});

@Controller('api/v1/dgi')
export class DgiController {
  constructor(
    @Inject(TransmissionService) private readonly transmission: TransmissionService,
    @Inject(DgiClient) private readonly client: DgiClient,
  ) {}

  /** État du connecteur, pour la supervision. */
  @Publique()
  @Get('etat')
  async etat() {
    return {
      disjoncteur: this.transmission.etatDisjoncteur,
      file: await this.transmission.etatFile(),
      dgiJoignable: await this.client.sante(),
    };
  }

  /**
   * Déclenche un cycle immédiatement.
   *
   * Utile en exploitation et dans les tests : on n'attend pas le prochain
   * intervalle pour vérifier qu'une reprise fonctionne.
   */
  @Roles('PROPRIETAIRE')
  @Post('traiter')
  @HttpCode(HttpStatus.OK)
  traiter() {
    return this.transmission.traiterLot(100);
  }

  /** Relance les transmissions bloquées, après correction d'un incident. */
  @Roles('PROPRIETAIRE')
  @Post('relancer')
  @HttpCode(HttpStatus.OK)
  async relancer() {
    return { relancees: await this.transmission.relancerInterventions() };
  }
}

@Controller('api/v1/archivage')
export class ArchivageController {
  constructor(@Inject(ArchivageService) private readonly archivage: ArchivageService) {}

  /** Vérifie la chaîne d'intégrité de l'entreprise connectée. */
  @Get('verification')
  verifier(
    @SessionCourante() session: Session,
    @Query('debut') debut?: string,
    @Query('fin') fin?: string,
  ) {
    return this.archivage.verifier(session.entrepriseId, {
      ...(debut ? { debut } : {}),
      ...(fin ? { fin } : {}),
    });
  }

  @Roles('PROPRIETAIRE', 'COMPTABLE')
  @Post('sceller')
  @HttpCode(HttpStatus.CREATED)
  sceller(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(periodeSchema)) corps: z.infer<typeof periodeSchema>,
  ) {
    return this.archivage.sceller(session.entrepriseId, corps);
  }

  /**
   * Export de contrôle fiscal.
   *
   * Réservé au propriétaire et au comptable : c'est l'intégralité des pièces
   * comptables de l'entreprise, un caissier n'a pas à pouvoir les extraire.
   */
  @Roles('PROPRIETAIRE', 'COMPTABLE')
  @Post('export')
  @HttpCode(HttpStatus.OK)
  exporter(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(exportSchema)) corps: z.infer<typeof exportSchema>,
  ) {
    return this.archivage.exporter(
      session.entrepriseId,
      { debut: corps.debut, fin: corps.fin },
      {
        parUtilisateur: session.utilisateurId,
        ...(corps.motif ? { motif: corps.motif } : {}),
      },
    );
  }
}

@Module({
  controllers: [DgiController, ArchivageController],
  providers: [DgiClient, TransmissionService, ArchivageService, OrdonnanceurTransmission],
  exports: [TransmissionService, ArchivageService],
})
export class DgiModule {}
