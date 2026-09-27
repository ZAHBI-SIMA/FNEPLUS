import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { EntreprisesService } from './entreprises.service.js';
import {
  nccSchema,
  regimeFiscalSchema,
  roleSchema,
  telephoneIvoirien,
  uuidSchema,
  ValidationZod,
} from '../commun/validation.js';
import { Publique, Roles, SessionCourante, type Session } from '../commun/auth.garde.js';

const inscriptionSchema = z.object({
  ncc: nccSchema,
  raisonSociale: z.string().trim().min(2, 'La raison sociale est obligatoire.').max(200),
  regimeFiscal: regimeFiscalSchema,
  telephone: telephoneIvoirien,
  adresse: z.string().trim().max(300).optional(),
  email: z.string().email('Adresse e-mail invalide.').optional(),
  nomProprietaire: z.string().trim().min(2, 'Le nom du responsable est obligatoire.').max(120),
  libellePointDeVente: z.string().trim().max(120).optional(),
});

const ajoutUtilisateurSchema = z.object({
  telephone: telephoneIvoirien,
  nom: z.string().trim().min(2).max(120),
  role: roleSchema,
  // Rattache l'utilisateur à une seule boutique (droits différenciés) ;
  // absent, il voit toutes les boutiques de l'entreprise.
  pointDeVenteId: uuidSchema.optional(),
});

const pointDeVenteSchema = z.object({
  libelle: z.string().trim().min(2, 'Le nom de la boutique est obligatoire.').max(120),
  adresse: z.string().trim().max(300).optional(),
});

@Controller('api/v1/entreprises')
export class EntreprisesController {
  constructor(@Inject(EntreprisesService) private readonly entreprises: EntreprisesService) {}

  @Publique()
  @Post('inscription')
  @HttpCode(HttpStatus.CREATED)
  inscrire(@Body(new ValidationZod(inscriptionSchema)) corps: z.infer<typeof inscriptionSchema>) {
    return this.entreprises.inscrire(corps);
  }

  @Get('moi')
  lire(@SessionCourante() session: Session) {
    return this.entreprises.lire(session.entrepriseId);
  }

  // Seul le propriétaire peut ajouter un caissier ou un comptable : c'est lui
  // qui porte la responsabilité fiscale de ce qui est émis en son nom.
  @Roles('PROPRIETAIRE')
  @Post('utilisateurs')
  @HttpCode(HttpStatus.CREATED)
  ajouterUtilisateur(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(ajoutUtilisateurSchema)) corps: z.infer<typeof ajoutUtilisateurSchema>,
  ) {
    return this.entreprises.ajouterUtilisateur(session.entrepriseId, corps);
  }

  // Même raison que pour l'ajout d'un utilisateur : ouvrir une nouvelle
  // boutique engage l'entreprise (numérotation, transmission DGI), seul le
  // propriétaire en décide.
  @Roles('PROPRIETAIRE')
  @Post('points-de-vente')
  @HttpCode(HttpStatus.CREATED)
  creerPointDeVente(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(pointDeVenteSchema)) corps: z.infer<typeof pointDeVenteSchema>,
  ) {
    return this.entreprises.creerPointDeVente(session.entrepriseId, corps);
  }

  // Un caissier rattaché à une boutique (droits différenciés) ne voit que la
  // sienne ; un propriétaire ou un comptable, sans boutique assignée, voient
  // la vue consolidée sur l'ensemble.
  @Get('points-de-vente/resume')
  resumeBoutiques(@SessionCourante() session: Session) {
    return this.entreprises.resumeBoutiques(session.entrepriseId, session.pointDeVenteId);
  }
}
