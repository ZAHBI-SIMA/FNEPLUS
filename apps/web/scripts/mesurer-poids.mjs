/**
 * Contrôle du budget de poids du premier chargement.
 *
 * Critère d'acceptation du Sprint 0 : moins de 200 Ko de JavaScript transférés
 * au premier chargement de la page d'accueil.
 *
 * On mesure ce que le navigateur télécharge RÉELLEMENT pour afficher `/` :
 * les entrées du manifeste de build pour cette route, dédupliquées, compressées
 * en gzip. Additionner tout `.next/static/chunks` compterait des bundles jamais
 * chargés ensemble et donnerait un chiffre faux.
 *
 * Les polyfills sont mesurés à part : ils ne sont servis qu'aux navigateurs
 * anciens — c'est-à-dire précisément aux appareils d'entrée de gamme de notre
 * cible. Ils sont donc reportés, même s'ils ne comptent pas dans le budget
 * nominal.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KO = 200;
const ROUTE = '/page';

const racineNext = resolve(process.cwd(), '.next');

async function lireJson(chemin) {
  return JSON.parse(await readFile(chemin, 'utf8'));
}

async function tailleGzipKo(cheminRelatif) {
  const chemin = join(racineNext, cheminRelatif);
  try {
    await stat(chemin);
  } catch {
    return 0;
  }
  return gzipSync(await readFile(chemin)).length / 1024;
}

async function principal() {
  let manifeste;
  try {
    manifeste = await lireJson(join(racineNext, 'app-build-manifest.json'));
  } catch {
    console.error('[poids] Manifeste introuvable. Lancez `pnpm build` avant la mesure.');
    process.exit(1);
  }

  const fichiersRoute = manifeste.pages?.[ROUTE];
  if (!fichiersRoute) {
    console.error(`[poids] Route ${ROUTE} absente du manifeste.`);
    process.exit(1);
  }

  const uniques = [...new Set(fichiersRoute)].filter((f) => f.endsWith('.js'));

  const details = [];
  let total = 0;
  for (const fichier of uniques) {
    const ko = await tailleGzipKo(fichier);
    total += ko;
    details.push({ fichier, ko });
  }

  details.sort((a, b) => b.ko - a.ko);

  console.log(`\nChargement initial de « ${ROUTE} » (gzip) :`);
  for (const d of details) {
    console.log(`  ${d.ko.toFixed(1).padStart(7)} Ko  ${d.fichier}`);
  }

  // Polyfills : servis uniquement aux navigateurs anciens, via nomodule.
  const buildManifest = await lireJson(join(racineNext, 'build-manifest.json'));
  const polyfills = buildManifest.polyfillFiles ?? [];
  let totalPolyfills = 0;
  for (const p of polyfills) totalPolyfills += await tailleGzipKo(p);

  console.log(`\nTotal chargement initial : ${total.toFixed(1)} Ko — budget ${BUDGET_KO} Ko`);
  console.log(
    `Polyfills navigateurs anciens (hors budget) : ${totalPolyfills.toFixed(1)} Ko`,
  );

  if (total > BUDGET_KO) {
    console.error(`\n❌ Budget de poids dépassé de ${(total - BUDGET_KO).toFixed(1)} Ko.`);
    process.exit(1);
  }
  console.log(`✅ Budget respecté (${((total / BUDGET_KO) * 100).toFixed(0)} % consommé).\n`);
}

await principal();
