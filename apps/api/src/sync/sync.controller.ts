import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { SyncService, type ReponseSync } from './sync.service.js';
import { uuidSchema, ValidationZod } from '../commun/validation.js';
import { SessionCourante, type Session } from '../commun/auth.garde.js';
import type { Commande } from '@fneplus/core';

const hlcSchema = z.object({
  murale: z.number().int().nonnegative(),
  compteur: z.number().int().nonnegative(),
  noeud: z.string().min(1),
});

/**
 * La charge utile de chaque commande n'est pas validée en détail ici : chaque
 * gestionnaire la valide selon son type, et une facture est de toute façon
 * recalculée intégralement côté serveur. Valider deux fois la même structure
 * mène surtout à ce que les deux validations divergent avec le temps.
 */
const commandeSchema = z.object({
  id: uuidSchema,
  type: z.enum([
    'CREER_FACTURE',
    'ENREGISTRER_PAIEMENT',
    'UPSERT_CLIENT',
    'UPSERT_PRODUIT',
    'CLOTURER_PLAGE',
  ]),
  entrepriseId: uuidSchema,
  terminalId: uuidSchema,
  hlc: hlcSchema,
  creeeLe: z.string(),
  charge: z.unknown(),
});

const syncSchema = z.object({
  terminalId: uuidSchema,
  // Lot borné : un terminal resté trois semaines hors ligne envoie ses commandes
  // par paquets plutôt qu'en une requête qui expirerait sur une 3G dégradée.
  commandes: z.array(commandeSchema).max(200),
  depuis: z.string().optional(),
});

@Controller('api/v1/sync')
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  synchroniser(
    @SessionCourante() session: Session,
    @Body(new ValidationZod(syncSchema)) corps: z.infer<typeof syncSchema>,
  ): Promise<ReponseSync> {
    return this.sync.synchroniser(session.entrepriseId, {
      terminalId: corps.terminalId,
      commandes: corps.commandes as unknown as Commande[],
      ...(corps.depuis ? { depuis: corps.depuis } : {}),
    });
  }
}
