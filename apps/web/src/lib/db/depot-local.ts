/**
 * Contrat d'accès à la base locale du terminal.
 *
 * Les dépôts (`factures`, `clients`, `produits`, `outbox`) dépendent de cette
 * interface, pas de l'implémentation SQLite WASM. Deux raisons :
 *
 *  1. **Testabilité.** SQLite WASM exige un navigateur et OPFS. En dépendant
 *     d'une interface, toute la logique hors ligne — émission, chaînage,
 *     outbox, synchronisation — s'exécute et se vérifie sous Node avec
 *     `node:sqlite`, contre le MÊME schéma SQL. Ce sont les vrais modules qui
 *     sont testés, pas des doubles qui finiraient par diverger.
 *
 *  2. **Portage.** Un empaquetage Capacitor (prévu en V2 pour le canal USSD)
 *     utilisera SQLite natif plutôt que WASM. Seule l'implémentation changera.
 */

export type ValeurSQL = string | number | null | Uint8Array;

export interface DepotLocal {
  /** Informations sur le mode de stockage, affichées à l'utilisateur. */
  readonly infos: {
    mode: 'OPFS' | 'MEMOIRE';
    versionSchema: number;
    versionSqlite: string;
    stockagePersistant: boolean;
    raisonDegradation?: 'AUTRE_ONGLET' | 'NON_SUPPORTE';
    avertissement?: string;
  };

  /** Requête retournant des lignes typées en objet. */
  interroger<T = Record<string, unknown>>(sql: string, bind?: ValeurSQL[]): T[];

  /** Requête sans résultat (INSERT / UPDATE / DELETE / DDL). */
  executer(sql: string, bind?: ValeurSQL[]): void;

  /**
   * Transaction synchrone.
   *
   * Synchrone de bout en bout : aucun `await` ne peut s'intercaler entre le
   * BEGIN et le COMMIT, donc aucune autre opération ne peut s'immiscer au
   * milieu d'une émission de facture.
   */
  transaction<T>(travail: () => T): T;

  journaliser(evenement: string, detail?: unknown): void;
}
