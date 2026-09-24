/**
 * Implémentation du dépôt local sur `node:sqlite`, pour les tests.
 *
 * Elle applique **exactement les mêmes migrations** que la base du terminal, et
 * les modules testés (`emettreFacture`, `outbox`, `synchroniser`) sont les
 * modules de production, sans adaptation. Ce qui est vérifié ici est donc le
 * comportement réel de l'application, pas celui d'un double qui finirait par
 * diverger du code embarqué.
 *
 * Ce fichier n'est importé que par des tests : il ne part pas dans le bundle.
 */

import { createRequire } from 'node:module';
import { MIGRATIONS, VERSION_SCHEMA_CIBLE } from '../lib/db/schema';
import type { DepotLocal, ValeurSQL } from '../lib/db/depot-local';

/**
 * `node:sqlite` n'existe que sous sa forme préfixée et n'apparaît pas dans
 * `builtinModules`. Vite en retire le préfixe avant de résoudre, puis échoue à
 * trouver un module « sqlite ». On charge donc le module par `require`, qui
 * court-circuite la résolution du bundler.
 */
interface BaseSqliteNode {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...bind: unknown[]): unknown[];
    run(...bind: unknown[]): unknown;
  };
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (chemin: string) => BaseSqliteNode;
};

export class DepotNode implements DepotLocal {
  private readonly db: BaseSqliteNode;

  readonly infos = {
    mode: 'OPFS' as const,
    versionSchema: VERSION_SCHEMA_CIBLE,
    versionSqlite: 'node:sqlite',
    stockagePersistant: true,
  };

  constructor(chemin = ':memory:') {
    this.db = new DatabaseSync(chemin);
    for (const migration of MIGRATIONS) {
      this.db.exec(migration.sql);
    }
  }

  interroger<T = Record<string, unknown>>(sql: string, bind: ValeurSQL[] = []): T[] {
    return this.db.prepare(sql).all(...(bind as never[])) as T[];
  }

  executer(sql: string, bind: ValeurSQL[] = []): void {
    this.db.prepare(sql).run(...(bind as never[]));
  }

  transaction<T>(travail: () => T): T {
    this.db.exec('BEGIN');
    try {
      const resultat = travail();
      this.db.exec('COMMIT');
      return resultat;
    } catch (erreur) {
      this.db.exec('ROLLBACK');
      throw erreur;
    }
  }

  journaliser(evenement: string, detail?: unknown): void {
    this.executer(
      'INSERT INTO journal_audit (survenu_le, evenement, detail_json) VALUES (?, ?, ?)',
      [new Date().toISOString(), evenement, detail === undefined ? null : JSON.stringify(detail)],
    );
  }

  fermer(): void {
    this.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Amorçage d'un terminal de test                                      */
/* ------------------------------------------------------------------ */

export const ENTREPRISE_TEST = '01900000-0000-7000-8000-000000000001';
export const PDV_TEST = '01900000-0000-7000-8000-000000000002';
export const TERMINAL_TEST = '01900000-0000-7000-8000-000000000003';
export const NCC_TEST = 'CI-TEST-0000001';

/** Prépare un terminal appairé avec une réserve de numéros. */
export function amorcerTerminal(
  base: DepotLocal,
  options: { taillePlage?: number; debut?: number } = {},
): void {
  const maintenant = new Date().toISOString();
  const debut = options.debut ?? 1;
  const fin = debut + (options.taillePlage ?? 1000) - 1;

  base.transaction(() => {
    base.executer(
      `INSERT INTO entreprises (id, ncc, raison_sociale, regime_fiscal, adresse, telephone, maj_le)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        ENTREPRISE_TEST,
        NCC_TEST,
        'Boutique de test',
        'REEL_SIMPLIFIE',
        'Abidjan',
        '+2250700000000',
        maintenant,
      ],
    );
    base.executer(
      `INSERT INTO points_de_vente (id, entreprise_id, libelle, code) VALUES (?, ?, ?, ?)`,
      [PDV_TEST, ENTREPRISE_TEST, 'Boutique principale', 'PDV01'],
    );
    base.executer(
      `INSERT INTO terminaux (id, entreprise_id, point_de_vente_id, libelle) VALUES (?, ?, ?, ?)`,
      [TERMINAL_TEST, ENTREPRISE_TEST, PDV_TEST, 'Caisse de test'],
    );
    base.executer(
      `INSERT INTO plages_numeros (
         id, entreprise_id, point_de_vente_id, terminal_id, prefixe,
         debut, fin, curseur, longueur_compteur, allouee_le
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `plage-${debut}`,
        ENTREPRISE_TEST,
        PDV_TEST,
        TERMINAL_TEST,
        'PDV01-2026',
        debut,
        fin,
        debut,
        6,
        maintenant,
      ],
    );
    base.executer(`INSERT INTO meta (cle, valeur) VALUES (?, ?)`, [
      'session',
      JSON.stringify({
        jeton: 'jeton-de-test',
        entrepriseId: ENTREPRISE_TEST,
        utilisateurId: 'utilisateur-test',
        role: 'PROPRIETAIRE',
        nom: 'Caissier de test',
        raisonSociale: 'Boutique de test',
        ncc: NCC_TEST,
        regimeFiscal: 'REEL_SIMPLIFIE',
        pointDeVenteId: PDV_TEST,
        terminalId: TERMINAL_TEST,
      }),
    ]);
  });
}
