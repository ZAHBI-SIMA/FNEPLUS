/**
 * Base locale du terminal — SQLite WASM persisté dans OPFS.
 *
 * ⚠️ Ce module ne s'exécute QUE dans le worker `base-locale.worker.ts`.
 *
 * Pourquoi un worker : le VFS `opfs-sahpool` repose sur
 * `FileSystemFileHandle.createSyncAccessHandle()`, qui n'est exposé que dans un
 * contexte worker. Le thread principal n'a pas accès aux poignées synchrones —
 * une tentative d'y installer le VFS échoue avec « Missing required OPFS APIs ».
 *
 * Le VFS `opfs` classique, lui, exigerait en plus les en-têtes COOP/COEP
 * (SharedArrayBuffer), donc l'isolation cross-origin de tout le site. On s'en
 * passe : `opfs-sahpool` est aussi nettement plus rapide en écriture, ce qui
 * compte sur un téléphone d'entrée de gamme.
 *
 * Contrepartie assumée : un seul onglet à la fois détient la base. Un second
 * onglet reçoit une erreur explicite plutôt qu'une corruption silencieuse.
 *
 * Si OPFS est indisponible (navigateur ancien, stockage bloqué), on bascule en
 * base mémoire et l'application le DIT clairement : un commerçant ne doit jamais
 * croire ses factures à l'abri alors qu'elles disparaîtront à la fermeture.
 */

import { MIGRATIONS, VERSION_SCHEMA_CIBLE } from './schema';
import type { DepotLocal, ValeurSQL } from './depot-local';

export type ModePersistance = 'OPFS' | 'MEMOIRE';

/** Pourquoi le terminal a dû renoncer au stockage persistant. */
export type RaisonDegradation =
  /** La base est déjà ouverte ailleurs (autre onglet, autre fenêtre). */
  | 'AUTRE_ONGLET'
  /** Le navigateur ne fournit pas les API nécessaires. */
  | 'NON_SUPPORTE';

export interface InfosBaseLocale {
  mode: ModePersistance;
  versionSchema: number;
  versionSqlite: string;
  /**
   * Vrai si le navigateur s'engage à ne pas évincer ces données.
   *
   * Sans cet engagement, le stockage est « au mieux » : le navigateur peut
   * l'effacer sous pression disque ou après une période d'inactivité. Pour un
   * produit qui promet de garder les factures sur l'appareil, c'est la
   * différence entre une promesse tenue et une promesse en l'air.
   */
  stockagePersistant: boolean;
  raisonDegradation?: RaisonDegradation;
  /** Renseigné en mode dégradé : à afficher à l'utilisateur. */
  avertissement?: string;
}

interface Sqlite3Db {
  exec(options: {
    sql: string;
    bind?: ValeurSQL[];
    rowMode?: 'object' | 'array';
    returnValue?: 'resultRows';
  }): unknown;
  close(): void;
}

interface Sqlite3Api {
  version: { libVersion: string };
  oo1: { DB: new (nom: string, drapeaux?: string) => Sqlite3Db };
  installOpfsSAHPoolVfs?: (options?: {
    name?: string;
    initialCapacity?: number;
  }) => Promise<{ OpfsSAHPoolDb: new (nom: string) => Sqlite3Db }>;
}

const NOM_FICHIER_BASE = '/fneplus.sqlite3';
const CHEMIN_MODULE_SQLITE = '/sqlite3/sqlite3.mjs';

/**
 * Demande au navigateur de ne pas évincer les données de cette origine.
 *
 * Par défaut, le stockage d'un site est « au mieux » : le navigateur peut
 * l'effacer sous pression disque, ou après une longue inactivité. Pour une
 * application dont la promesse est « vos factures sont gardées sur l'appareil »,
 * c'est inacceptable — une facture émise hors ligne et pas encore transmise
 * disparaîtrait sans que personne ne s'en aperçoive.
 *
 * Chrome accorde généralement la permission sans invite lorsque le site est
 * installé en PWA ou régulièrement visité. Un refus n'est pas bloquant, mais il
 * est signalé à l'utilisateur.
 */
async function demanderPersistance(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Ouvre le VFS OPFS, avec quelques reprises.
 *
 * Le VFS `sahpool` verrouille ses fichiers : un onglet qui vient d'être fermé
 * peut mettre un instant à les relâcher, et un rechargement rapide tombe alors
 * sur un verrou encore tenu. Basculer immédiatement en mémoire dans ce cas
 * ferait perdre la session et les factures en attente pour un simple
 * chevauchement de quelques centaines de millisecondes — on réessaie donc avant
 * de renoncer, et on distingue ce cas d'une absence réelle de support.
 */
async function ouvrirAvecReprises(
  sqlite3: Sqlite3Api,
): Promise<{ db: Sqlite3Db | null; verrouille: boolean; erreur?: unknown }> {
  const DELAIS_MS = [0, 250, 750, 1500];
  let derniereErreur: unknown;

  for (const delai of DELAIS_MS) {
    if (delai > 0) await new Promise((r) => setTimeout(r, delai));

    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs!({
        name: 'fneplus',
        initialCapacity: 6,
      });
      return { db: new pool.OpfsSAHPoolDb(NOM_FICHIER_BASE), verrouille: false };
    } catch (erreur) {
      derniereErreur = erreur;
      const nom = (erreur as { name?: string }).name;
      // Une erreur autre qu'un verrou ne s'arrangera pas avec le temps.
      if (nom !== 'NoModificationAllowedError' && nom !== 'InvalidStateError') break;
    }
  }

  const nom = (derniereErreur as { name?: string })?.name;
  return {
    db: null,
    verrouille: nom === 'NoModificationAllowedError' || nom === 'InvalidStateError',
    erreur: derniereErreur,
  };
}

export class ErreurBaseLocale extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ErreurBaseLocale';
  }
}

export class BaseLocale implements DepotLocal {
  private constructor(
    private readonly db: Sqlite3Db,
    readonly infos: InfosBaseLocale,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Ouverture                                                           */
  /* ------------------------------------------------------------------ */

  static async ouvrir(): Promise<BaseLocale> {
    const module = (await import(/* webpackIgnore: true */ CHEMIN_MODULE_SQLITE)) as {
      default: (config?: {
        print?: (m: string) => void;
        printErr?: (m: string) => void;
      }) => Promise<Sqlite3Api>;
    };

    const sqlite3 = await module.default({
      print: () => {},
      // Le VFS `opfs` classique se plaint de l'absence de COOP/COEP au
      // chargement : c'est attendu, on utilise `opfs-sahpool`. On n'escalade pas
      // ce message en erreur pour ne pas noyer les vrais problèmes.
      printErr: () => {},
    });

    // Demandé avant même d'ouvrir la base : sans cet engagement du navigateur,
    // tout ce qu'on écrit ensuite peut être effacé sans préavis.
    const stockagePersistant = await demanderPersistance();

    let db: Sqlite3Db;
    let mode: ModePersistance;
    let avertissement: string | undefined;
    let raisonDegradation: RaisonDegradation | undefined;

    if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
      const ouverture = await ouvrirAvecReprises(sqlite3);

      if (ouverture.db) {
        db = ouverture.db;
        mode = 'OPFS';
      } else {
        console.error('[base-locale] OPFS indisponible, bascule en mémoire', ouverture.erreur);
        db = new sqlite3.oo1.DB(':memory:', 'c');
        mode = 'MEMOIRE';
        raisonDegradation = ouverture.verrouille ? 'AUTRE_ONGLET' : 'NON_SUPPORTE';
        avertissement = ouverture.verrouille
          ? 'FNE+ est déjà ouvert dans un autre onglet. Fermez-le puis rechargez cette page : tant que les deux sont ouverts, les factures émises ici ne seraient pas conservées.'
          : 'Cet appareil ne peut pas conserver les factures hors ligne. Restez connecté : une facture émise serait perdue si l’application se fermait.';
      }
    } else {
      db = new sqlite3.oo1.DB(':memory:', 'c');
      mode = 'MEMOIRE';
      raisonDegradation = 'NON_SUPPORTE';
      avertissement =
        'Le stockage local n’est pas disponible sur ce navigateur. Mettez-le à jour pour pouvoir facturer hors ligne.';
    }

    if (mode === 'OPFS' && !stockagePersistant) {
      avertissement =
        'Le navigateur n’a pas garanti la conservation des données de cet appareil. Installez FNE+ depuis le menu du navigateur pour que vos factures ne puissent pas être effacées automatiquement.';
    }

    const base = new BaseLocale(db, {
      mode,
      versionSchema: 0,
      versionSqlite: sqlite3.version.libVersion,
      stockagePersistant,
      ...(raisonDegradation ? { raisonDegradation } : {}),
      ...(avertissement ? { avertissement } : {}),
    });

    base.migrer();
    return new BaseLocale(db, { ...base.infos, versionSchema: VERSION_SCHEMA_CIBLE });
  }

  /* ------------------------------------------------------------------ */
  /* Migrations                                                          */
  /* ------------------------------------------------------------------ */

  private migrer(): void {
    const actuelle = this.versionSchemaCourante();

    for (const migration of MIGRATIONS) {
      if (migration.version <= actuelle) continue;
      try {
        this.db.exec({ sql: 'BEGIN' });
        this.db.exec({ sql: migration.sql });
        this.db.exec({ sql: `PRAGMA user_version = ${migration.version}` });
        this.db.exec({ sql: 'COMMIT' });
      } catch (erreur) {
        this.db.exec({ sql: 'ROLLBACK' });
        throw new ErreurBaseLocale(
          `Échec de la migration ${migration.version} (${migration.nom})`,
          erreur,
        );
      }
    }
  }

  private versionSchemaCourante(): number {
    const lignes = this.db.exec({
      sql: 'PRAGMA user_version',
      rowMode: 'array',
      returnValue: 'resultRows',
    }) as unknown[][];
    const premiere = lignes[0];
    return typeof premiere?.[0] === 'number' ? premiere[0] : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Accès                                                               */
  /* ------------------------------------------------------------------ */

  /** Requête retournant des lignes typées en objet. */
  interroger<T = Record<string, unknown>>(sql: string, bind: ValeurSQL[] = []): T[] {
    return this.db.exec({
      sql,
      bind,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as T[];
  }

  /** Requête sans résultat (INSERT / UPDATE / DELETE / DDL). */
  executer(sql: string, bind: ValeurSQL[] = []): void {
    this.db.exec({ sql, bind });
  }

  /**
   * Transaction synchrone.
   *
   * Elle est synchrone de bout en bout, dans le worker : aucun `await` ne peut
   * s'intercaler entre le BEGIN et le COMMIT, donc aucune autre opération ne
   * peut s'immiscer au milieu d'une émission de facture.
   */
  transaction<T>(travail: () => T): T {
    this.db.exec({ sql: 'BEGIN' });
    try {
      const resultat = travail();
      this.db.exec({ sql: 'COMMIT' });
      return resultat;
    } catch (erreur) {
      this.db.exec({ sql: 'ROLLBACK' });
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

/* -------------------------------------------------------------------- */
/* Singleton, au sein du worker                                          */
/* -------------------------------------------------------------------- */

let instance: Promise<BaseLocale> | null = null;

export function baseLocale(): Promise<BaseLocale> {
  instance ??= BaseLocale.ouvrir();
  return instance;
}
