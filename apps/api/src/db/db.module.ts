/**
 * Accès à PostgreSQL.
 *
 * Point central du multi-tenant : toute lecture ou écriture de données métier
 * passe par `avecTenant()`, qui ouvre une transaction et y pose le contexte
 * d'entreprise. Les politiques RLS s'appuient dessus.
 *
 * `SET LOCAL` et non `SET` : le réglage meurt avec la transaction. Sur un pool
 * de connexions, un `SET` persistant laisserait le contexte d'un client attaché
 * à la connexion recyclée par le client suivant — exactement la fuite que la RLS
 * est censée empêcher.
 */

import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import postgres from 'postgres';
import { chargerConfiguration, type Configuration } from '../config.js';

export const JETON_SQL = Symbol('JETON_SQL');
export const JETON_CONFIG = Symbol('JETON_CONFIG');

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

@Injectable()
export class BaseDeDonnees implements OnModuleDestroy {
  constructor(@Inject(JETON_SQL) readonly sql: Sql) {}

  /**
   * Exécute un travail dans le contexte d'une entreprise.
   *
   * Hors de cette méthode, les politiques RLS ne laissent passer aucune ligne :
   * c'est voulu. Un développeur qui oublie le contexte obtient zéro résultat,
   * jamais les données d'un autre client.
   */
  async avecTenant<T>(
    entrepriseId: string,
    travail: (tx: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('fneplus.entreprise_id', ${entrepriseId}, true)`;
      return travail(tx);
    }) as Promise<T>;
  }

  /**
   * Transaction sans contexte tenant.
   *
   * Réservée aux opérations qui n'ont pas encore d'entreprise connue : demande
   * de code OTP, résolution d'un numéro de téléphone, lecture du référentiel
   * fiscal. Tout autre usage est un défaut à corriger.
   */
  async horsTenant<T>(travail: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(travail) as Promise<T>;
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: JETON_CONFIG,
      useFactory: (): Configuration => chargerConfiguration(),
    },
    {
      provide: JETON_SQL,
      inject: [JETON_CONFIG],
      useFactory: (config: Configuration): Sql =>
        postgres(config.DATABASE_URL, {
          max: 10,
          // Les montants sont des BIGINT en base mais tiennent largement dans un
          // entier sûr JavaScript (le PIB ivoirien en francs CFA y tient) : on
          // les lit en nombre plutôt qu'en chaîne, pour éviter des conversions
          // partout dans le code métier.
          types: {
            bigint: {
              to: 20,
              from: [20],
              serialize: (v: number) => String(v),
              parse: (v: string) => Number(v),
            },
          },
          onnotice: () => {},
        }),
    },
    BaseDeDonnees,
  ],
  exports: [BaseDeDonnees, JETON_CONFIG, JETON_SQL],
})
export class DbModule {}
