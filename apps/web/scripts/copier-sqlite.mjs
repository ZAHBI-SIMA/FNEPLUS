/**
 * Copie le runtime SQLite WASM dans `public/sqlite3/`.
 *
 * Il est servi comme un asset statique plutôt qu'empaqueté par le bundler :
 *  - le .wasm reste hors du bundle JavaScript, donc hors du budget de poids
 *    du premier chargement ;
 *  - il est mis en cache par le service worker avec sa propre durée de vie ;
 *  - le module se charge en `import()` dynamique, à la demande.
 *
 * Le paquet ne déclare pas de point d'entrée `exports` exploitable par
 * `require.resolve`, on localise donc le dossier en remontant les `node_modules`.
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const SOUS_CHEMIN = join('@sqlite.org', 'sqlite-wasm', 'sqlite-wasm', 'jswasm');

async function localiserRuntime() {
  let dossier = process.cwd();

  for (;;) {
    const candidat = join(dossier, 'node_modules', SOUS_CHEMIN);
    try {
      await stat(candidat);
      return candidat;
    } catch {
      const parent = dirname(dossier);
      if (parent === dossier) return null;
      dossier = parent;
    }
  }
}

const source = await localiserRuntime();

if (!source) {
  console.error(
    '[copier-sqlite] Runtime SQLite WASM introuvable. Lancez `pnpm install` avant le build.',
  );
  process.exit(1);
}

const destination = resolve(process.cwd(), 'public', 'sqlite3');
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const fichiers = await readdir(destination);
console.log(`[copier-sqlite] ${fichiers.length} fichiers copiés vers public/sqlite3/`);
