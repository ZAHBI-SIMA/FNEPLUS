/**
 * Validation des entrées par Zod.
 *
 * Les messages d'erreur sont en français et destinés à être affichés tels quels :
 * une API dont les erreurs ne sont pas lisibles finit par être enveloppée dans
 * des traductions approximatives côté client.
 */

import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z, type ZodSchema } from 'zod';

export class ValidationZod<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(valeur: unknown): T {
    const resultat = this.schema.safeParse(valeur);
    if (resultat.success) return resultat.data;

    throw new BadRequestException({
      code: 'REQUETE_INVALIDE',
      message: 'Les informations envoyées ne sont pas valides.',
      details: resultat.error.issues.map((i) => ({
        champ: i.path.join('.'),
        message: i.message,
      })),
    });
  }
}

/**
 * Numéro de téléphone ivoirien.
 *
 * Accepte les formes réellement saisies par les utilisateurs — avec ou sans
 * indicatif, avec espaces ou points — et normalise en E.164. Refuser une saisie
 * parce qu'elle contient des espaces est une cause d'abandon à l'inscription.
 */
export const telephoneIvoirien = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s.\-()]/g, ''))
  .refine((v) => /^(\+225)?[0-9]{10}$/.test(v), {
    message: 'Numéro de téléphone ivoirien invalide (10 chiffres attendus).',
  })
  .transform((v) => (v.startsWith('+225') ? v : `+225${v}`));

/** Numéro de Compte Contribuable. Format à confirmer auprès de la DGI. */
export const nccSchema = z
  .string()
  .trim()
  .min(6, 'Le NCC doit comporter au moins 6 caractères.')
  .max(32, 'Le NCC ne peut pas dépasser 32 caractères.')
  .transform((v) => v.toUpperCase());

export const regimeFiscalSchema = z.enum([
  'ENTREPRENANT',
  'MICROENTREPRISE',
  'REEL_SIMPLIFIE',
  'REEL_NORMAL',
]);

export const roleSchema = z.enum(['PROPRIETAIRE', 'CAISSIER', 'COMPTABLE']);

export const uuidSchema = z.string().uuid('Identifiant invalide.');

/** Le PIN protège une caisse, pas un compte bancaire : 4 à 6 chiffres. */
export const pinSchema = z
  .string()
  .regex(/^[0-9]{4,6}$/, 'Le code doit comporter de 4 à 6 chiffres.');
