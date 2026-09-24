/**
 * Configuration de l'API.
 *
 * Validée au démarrage : une variable manquante doit faire échouer le lancement
 * immédiatement, pas provoquer une erreur obscure trois heures plus tard en
 * production. Les valeurs par défaut n'existent que pour le développement local,
 * et le secret JWT n'en a volontairement aucune.
 */

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4001),

  /** Connexion applicative : rôle `fneplus_app`, soumis à la RLS. */
  DATABASE_URL: z.string().default('postgres://fneplus_app:fneplus_app_dev@localhost:5435/fneplus'),

  /** Connexion d'administration : propriétaire des tables, pour les migrations. */
  DATABASE_URL_ADMIN: z.string().default('postgres://fneplus:fneplus_dev@localhost:5435/fneplus'),

  JWT_SECRET: z.string().min(32).default('secret-de-developpement-a-remplacer-absolument-32'),
  /** Durée de validité d'un jeton, en secondes (12 h par défaut). */
  JWT_DUREE_SECONDES: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 60 * 60),

  /**
   * Fournisseur SMS. `console` écrit le code OTP dans les logs : pratique en
   * développement, interdit ailleurs — le garde-fou est plus bas.
   */
  SMS_FOURNISSEUR: z.enum(['console', 'orange', 'mtn']).default('console'),

  /**
   * API FNE de la DGI. Pointe par défaut sur le simulateur local tant que
   * l'accès au bac à sable officiel n'est pas acquis.
   */
  DGI_URL: z.string().default('http://localhost:4010'),
  DGI_CLE_API: z.string().optional(),
  DGI_DELAI_ATTENTE_MS: z.coerce.number().int().positive().default(20_000),
  /** Échecs consécutifs avant que le disjoncteur ne coupe. */
  DGI_SEUIL_DISJONCTEUR: z.coerce.number().int().positive().default(5),
  /** Durée pendant laquelle le disjoncteur reste ouvert, en millisecondes. */
  DGI_DUREE_OUVERTURE_MS: z.coerce.number().int().positive().default(30_000),

  REDIS_URL: z.string().default('redis://localhost:6380'),

  /** Taille des plages de numéros allouées à un terminal. */
  TAILLE_PLAGE_NUMEROS: z.coerce.number().int().positive().default(500),
});

export type Configuration = z.infer<typeof schema>;

export function chargerConfiguration(source: NodeJS.ProcessEnv = process.env): Configuration {
  const resultat = schema.safeParse(source);

  if (!resultat.success) {
    const details = resultat.error.issues
      .map((i) => `  - ${i.path.join('.')} : ${i.message}`)
      .join('\n');
    throw new Error(`Configuration invalide :\n${details}`);
  }

  const config = resultat.data;

  if (config.NODE_ENV === 'production') {
    if (config.JWT_SECRET.startsWith('secret-de-developpement')) {
      throw new Error('JWT_SECRET doit être défini en production.');
    }
    if (config.DGI_URL.includes('localhost')) {
      throw new Error(
        'DGI_URL pointe encore sur le simulateur local : la production doit viser l’API réelle de la DGI.',
      );
    }
    if (config.SMS_FOURNISSEUR === 'console') {
      throw new Error(
        'SMS_FOURNISSEUR ne peut pas rester « console » en production : les codes OTP seraient écrits dans les logs.',
      );
    }
  }

  return config;
}
