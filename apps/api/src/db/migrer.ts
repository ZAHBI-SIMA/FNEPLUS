/**
 * Exécution des migrations SQL.
 *
 * Volontairement sans outil de migration tiers : le schéma repose sur des
 * fonctionnalités PostgreSQL que les générateurs d'ORM rendent mal (Row Level
 * Security, contrainte d'exclusion GiST, fonctions SECURITY DEFINER). Du SQL
 * écrit à la main, versionné et rejoué dans l'ordre, reste plus lisible et plus
 * sûr ici qu'un schéma déduit.
 *
 * Les migrations s'exécutent avec le rôle PROPRIÉTAIRE de la base, qui contourne
 * la RLS. L'application, elle, se connecte avec `fneplus_app`, qui ne la
 * contourne pas.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DOSSIER = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrer(urlBase: string): Promise<string[]> {
  const sql = postgres(urlBase, { max: 1, onnotice: () => {} });
  const appliquees: string[] = [];

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS migrations_appliquees (
        nom          TEXT PRIMARY KEY,
        appliquee_le TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const fichiers = (await readdir(DOSSIER)).filter((f) => f.endsWith('.sql')).sort();

    const deja = await sql<{ nom: string }[]>`SELECT nom FROM migrations_appliquees`;
    const dejaAppliquees = new Set(deja.map((l) => l.nom));

    for (const fichier of fichiers) {
      if (dejaAppliquees.has(fichier)) continue;

      const contenu = await readFile(join(DOSSIER, fichier), 'utf8');

      // Chaque migration est atomique : elle passe entièrement ou pas du tout.
      // Une migration à moitié appliquée est bien plus coûteuse à réparer
      // qu'une migration qui échoue franchement.
      await sql.begin(async (tx) => {
        await tx.unsafe(contenu);
        await tx`INSERT INTO migrations_appliquees (nom) VALUES (${fichier})`;
      });

      appliquees.push(fichier);
      console.log(`[migrer] ${fichier} appliquée`);
    }

    if (appliquees.length === 0) console.log('[migrer] schéma déjà à jour');
    return appliquees;
  } finally {
    await sql.end();
  }
}

// Exécution directe : `pnpm --filter @fneplus/api migrer`
if (process.argv[1]?.includes('migrer')) {
  const url =
    process.env.DATABASE_URL_ADMIN ?? 'postgres://fneplus:fneplus_dev@localhost:5435/fneplus';
  await migrer(url);
  process.exit(0);
}
