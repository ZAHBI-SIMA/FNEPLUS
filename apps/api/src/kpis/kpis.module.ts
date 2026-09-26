/**
 * Indicateurs de succès (chapitre 10 du cahier des charges).
 *
 * Deux échelles, pas une seule :
 *  - **Par entreprise** (usage, conformité) : utile au commerçant lui-même —
 *    combien de factures ce mois-ci, quelle part est partie hors ligne, sa
 *    facture arrive-t-elle à la DGI dans les temps. Exposé dans son tableau de
 *    bord comme n'importe quelle autre donnée de son compte, via le contexte
 *    tenant normal.
 *  - **Plateforme** (adoption, rétention) : n'a de sens qu'agrégé sur tous les
 *    clients — ce n'est pas la donnée d'un compte, c'est une donnée sur
 *    l'activité elle-même. Il n'existe aucun rôle « opérateur » dans
 *    l'application ; plutôt que d'en créer un pour ce seul besoin, l'accès
 *    passe par un jeton dédié (`KPI_JETON_OPERATEUR`), sur le modèle d'un
 *    point de métriques d'exploitation.
 *
 * **Satisfaction** (Net Promoter Score, délai de résolution des tickets
 * support) n'a aucune source de données ici : rien ne collecte d'enquête ni de
 * ticket. Le champ dit explicitement qu'il manque un outil à brancher, plutôt
 * que d'inventer un chiffre.
 */

import {
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  Module,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { BaseDeDonnees, JETON_CONFIG } from '../db/db.module.js';
import type { Configuration } from '../config.js';
import { Publique, SessionCourante, type Session } from '../commun/auth.garde.js';

export interface KpisEntreprise {
  periodeJours: number;
  delaiReglementaireHeures: number;
  usage: {
    nombreFactures: number;
    partHorsLignePourcent: number | null;
    delaiMoyenSyncSecondes: number | null;
  };
  conformite: {
    nombreCertifiees: number;
    partDansLeDelaiPourcent: number | null;
  };
}

export interface KpisPlateforme {
  genereLe: string;
  periodeJours: number;
  delaiReglementaireHeures: number;
  adoption: {
    entreprisesInscritesTotal: number;
    entreprisesNouvellesCeMois: number;
    entreprisesActivesCeMois: number;
    tauxConversionPourcent: number | null;
  };
  retention: {
    tailleCohorteSixMois: number;
    encoreActifsApresSixMoisPourcent: number | null;
    tauxDesabonnementMensuelPourcent: number | null;
  };
  usage: {
    nombreFactures: number;
    partHorsLignePourcent: number | null;
    delaiMoyenSyncSecondes: number | null;
  };
  conformite: {
    nombreCertifiees: number;
    partDansLeDelaiPourcent: number | null;
    partEntreprisesArfAJourPourcent: number | null;
  };
  satisfaction: null;
  satisfactionNote: string;
}

/** Pourcentage arrondi à une décimale ; `null` sans dénominateur, jamais une division par zéro. */
function pourcentage(numerateur: number, denominateur: number): number | null {
  if (denominateur === 0) return null;
  return Math.round((numerateur / denominateur) * 1000) / 10;
}

@Injectable()
export class KpisService {
  constructor(
    @Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees,
    @Inject(JETON_CONFIG) private readonly config: Configuration,
  ) {}

  async entreprise(entrepriseId: string, periodeJours = 30): Promise<KpisEntreprise> {
    const delaiHeures = this.config.KPI_DELAI_REGLEMENTAIRE_HEURES;

    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [usage] = await tx<
        {
          nombre_factures: number;
          nombre_hors_ligne: number;
          delai_moyen_secondes: number | null;
        }[]
      >`
        SELECT
          COUNT(*)::int AS nombre_factures,
          COUNT(*) FILTER (WHERE recue_le - emise_le > interval '10 seconds')::int AS nombre_hors_ligne,
          AVG(EXTRACT(EPOCH FROM (recue_le - emise_le))) AS delai_moyen_secondes
          FROM factures
         WHERE entreprise_id = ${entrepriseId}
           AND emise_le >= now() - (${periodeJours} || ' days')::interval
      `;

      const [conformite] = await tx<{ nombre_certifiees: number; nombre_dans_delai: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE ft.etat = 'CERTIFIEE')::int AS nombre_certifiees,
          COUNT(*) FILTER (
            WHERE ft.etat = 'CERTIFIEE'
              AND ft.terminee_le - f.emise_le <= (${delaiHeures} || ' hours')::interval
          )::int AS nombre_dans_delai
          FROM factures f
          LEFT JOIN file_transmission ft ON ft.facture_id = f.id
         WHERE f.entreprise_id = ${entrepriseId}
           AND f.emise_le >= now() - (${periodeJours} || ' days')::interval
      `;

      const nombreFactures = usage?.nombre_factures ?? 0;
      const nombreCertifiees = conformite?.nombre_certifiees ?? 0;

      return {
        periodeJours,
        delaiReglementaireHeures: delaiHeures,
        usage: {
          nombreFactures,
          partHorsLignePourcent: pourcentage(usage?.nombre_hors_ligne ?? 0, nombreFactures),
          delaiMoyenSyncSecondes: usage?.delai_moyen_secondes
            ? Math.round(usage.delai_moyen_secondes)
            : null,
        },
        conformite: {
          nombreCertifiees,
          partDansLeDelaiPourcent: pourcentage(
            conformite?.nombre_dans_delai ?? 0,
            nombreCertifiees,
          ),
        },
      };
    });
  }

  /** Vérifie le jeton d'exploitation en temps constant, comme une signature de webhook. */
  verifierJetonOperateur(jeton: string | undefined): boolean {
    if (!jeton) return false;
    const attendu = Buffer.from(this.config.KPI_JETON_OPERATEUR);
    const recu = Buffer.from(jeton);
    if (attendu.length !== recu.length) return false;
    return timingSafeEqual(attendu, recu);
  }

  async plateforme(periodeJours = 30): Promise<KpisPlateforme> {
    const delaiHeures = this.config.KPI_DELAI_REGLEMENTAIRE_HEURES;

    const brut = await this.bdd.horsTenant(async (tx) => {
      const [ligne] = await tx<{ fneplus_kpis_plateforme: KpisBrut }[]>`
        SELECT fneplus_kpis_plateforme(${periodeJours}, ${delaiHeures})
      `;
      return ligne!.fneplus_kpis_plateforme;
    });

    const entreprisesActivesTotal = brut.adoption.entreprisesAyantEmisTotal;
    const entreprisesInscritesTotal = brut.adoption.entreprisesInscritesTotal;

    return {
      genereLe: brut.genereLe,
      periodeJours,
      delaiReglementaireHeures: delaiHeures,
      adoption: {
        entreprisesInscritesTotal,
        entreprisesNouvellesCeMois: brut.adoption.entreprisesNouvellesCeMois,
        entreprisesActivesCeMois: brut.adoption.entreprisesActivesCeMois,
        tauxConversionPourcent: pourcentage(entreprisesActivesTotal, entreprisesInscritesTotal),
      },
      retention: {
        tailleCohorteSixMois: brut.retention.tailleCohorteSixMois,
        encoreActifsApresSixMoisPourcent: pourcentage(
          brut.retention.encoreActifsApresSixMois,
          brut.retention.tailleCohorteSixMois,
        ),
        // Désabonnement = actifs du mois dernier qui n'apparaissent plus ce
        // mois-ci ; on ne connaît que les deux effectifs, pas l'intersection
        // exacte depuis cette requête agrégée — approximation par différence,
        // bornée à zéro plutôt que négative si l'activité progresse.
        tauxDesabonnementMensuelPourcent: pourcentage(
          Math.max(0, brut.retention.actifsMoisPrecedent - brut.retention.actifsMoisCourant),
          brut.retention.actifsMoisPrecedent,
        ),
      },
      usage: {
        nombreFactures: brut.usage.nombreFactures,
        partHorsLignePourcent: pourcentage(brut.usage.nombreHorsLigne, brut.usage.nombreFactures),
        delaiMoyenSyncSecondes: brut.usage.delaiMoyenSyncSecondes
          ? Math.round(brut.usage.delaiMoyenSyncSecondes)
          : null,
      },
      conformite: {
        nombreCertifiees: brut.conformite.nombreCertifiees,
        partDansLeDelaiPourcent: pourcentage(
          brut.conformite.nombreDansLeDelai,
          brut.conformite.nombreCertifiees,
        ),
        partEntreprisesArfAJourPourcent: pourcentage(
          brut.conformite.entreprisesArfAJour,
          brut.conformite.entreprisesAvecAttestation,
        ),
      },
      satisfaction: null,
      satisfactionNote:
        'Non mesurable : aucune enquête de satisfaction ni système de tickets support ne collecte de données dans cette application. Nécessite de brancher un outil dédié (chapitre 10 du cahier des charges).',
    };
  }
}

interface KpisBrut {
  genereLe: string;
  adoption: {
    entreprisesInscritesTotal: number;
    entreprisesNouvellesCeMois: number;
    entreprisesActivesCeMois: number;
    entreprisesAyantEmisTotal: number;
  };
  retention: {
    tailleCohorteSixMois: number;
    encoreActifsApresSixMois: number;
    actifsMoisPrecedent: number;
    actifsMoisCourant: number;
  };
  usage: {
    nombreFactures: number;
    nombreHorsLigne: number;
    delaiMoyenSyncSecondes: number | null;
  };
  conformite: {
    nombreCertifiees: number;
    nombreDansLeDelai: number;
    entreprisesAvecAttestation: number;
    entreprisesArfAJour: number;
  };
}

@Controller('api/v1/kpis')
export class KpisController {
  constructor(@Inject(KpisService) private readonly kpis: KpisService) {}

  @Get('entreprise')
  entreprise(@SessionCourante() session: Session, @Query('jours') jours?: string) {
    return this.kpis.entreprise(session.entrepriseId, jours ? Number(jours) : undefined);
  }

  // Public au sens du garde d'authentification par jeton utilisateur : l'accès
  // réel est vérifié ci-dessous, par un jeton d'exploitation distinct — cette
  // route ne concerne aucun compte en particulier.
  @Publique()
  @Get('plateforme')
  async plateforme(
    @Headers('x-jeton-operateur') jetonOperateur: string | undefined,
    @Query('jours') jours?: string,
  ) {
    if (!this.kpis.verifierJetonOperateur(jetonOperateur)) {
      throw new UnauthorizedException({
        code: 'JETON_OPERATEUR_INVALIDE',
        message: 'Jeton d’exploitation invalide ou absent.',
      });
    }
    return this.kpis.plateforme(jours ? Number(jours) : undefined);
  }
}

@Module({
  controllers: [KpisController],
  providers: [KpisService],
  exports: [KpisService],
})
export class KpisModule {}
