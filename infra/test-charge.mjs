#!/usr/bin/env node
/**
 * Test de charge — chemin de lecture de l'API.
 *
 * Vise les points d'accès lus à chaque ouverture d'écran (référentiels
 * fiscaux, situation ARF, indicateurs) plutôt que l'émission de factures :
 * celle-ci n'appelle jamais le serveur ([[D-002]], le calcul et le chaînage
 * tournent entièrement sur l'appareil), donc aucune charge serveur n'existe à
 * mesurer sur ce chemin. Ce que la disponibilité du pilote (99,5 %) dépend
 * réellement du serveur, c'est la synchronisation et les écrans qui
 * l'interrogent — c'est ce que ce script charge.
 *
 * Usage : node infra/test-charge.mjs [--concurrence=20] [--requetes=500]
 */

const URL_API = process.env.API_URL ?? 'http://localhost:4001';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [cle, valeur] = a.replace(/^--/, '').split('=');
    return [cle, valeur ?? 'true'];
  }),
);
const CONCURRENCE = Number(args['concurrence'] ?? 20);
const REQUETES_TOTAL = Number(args['requetes'] ?? 500);

async function appeler(chemin, options = {}) {
  const depart = performance.now();
  try {
    const reponse = await fetch(`${URL_API}${chemin}`, options);
    await reponse.arrayBuffer(); // consomme le corps, sinon la connexion ne se libère pas
    return { statut: reponse.status, dureeMs: performance.now() - depart };
  } catch (erreur) {
    return { statut: 0, dureeMs: performance.now() - depart, erreur: String(erreur) };
  }
}

async function obtenirJeton() {
  const telephone = `+2250799${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
  const inscription = await fetch(`${URL_API}/api/v1/entreprises/inscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ncc: `CI-CHARGE-${Date.now()}`,
      raisonSociale: 'Boutique test de charge',
      regimeFiscal: 'REEL_SIMPLIFIE',
      telephone,
      nomProprietaire: 'Test de charge',
    }),
  }).then((r) => r.json());

  await fetch(`${URL_API}/api/v1/auth/demander-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telephone }),
  });

  // SMS_FOURNISSEUR=console : le code est dans les logs de l'API, pas
  // récupérable par ce script. On définit un PIN via le flux normal n'est pas
  // possible sans lire le code — ce script suppose donc que l'API tourne déjà
  // avec une entreprise de test accessible par jeton fourni en variable
  // d'environnement (FNEPLUS_JETON_TEST), ou se limite aux points d'accès
  // publics si absent.
  void inscription;
  return process.env.FNEPLUS_JETON_TEST ?? null;
}

function percentile(triees, p) {
  const indice = Math.min(triees.length - 1, Math.floor((p / 100) * triees.length));
  return triees[indice];
}

function resumer(nom, resultats) {
  const durees = resultats.map((r) => r.dureeMs).sort((a, b) => a - b);
  const reussies = resultats.filter((r) => r.statut >= 200 && r.statut < 300).length;
  const total = resultats.length;
  const moyenne = durees.reduce((a, b) => a + b, 0) / total;

  console.log(`\n${nom} — ${total} requêtes, ${reussies} réussies (${((reussies / total) * 100).toFixed(1)} %)`);
  console.log(
    `  latence : min ${durees[0].toFixed(0)} ms · moyenne ${moyenne.toFixed(0)} ms · ` +
      `p95 ${percentile(durees, 95).toFixed(0)} ms · max ${durees[durees.length - 1].toFixed(0)} ms`,
  );
}

async function vague(fabriquerRequete, total, concurrence) {
  const resultats = [];
  let lancees = 0;
  async function travailleur() {
    while (lancees < total) {
      lancees++;
      resultats.push(await fabriquerRequete());
    }
  }
  await Promise.all(Array.from({ length: concurrence }, travailleur));
  return resultats;
}

async function main() {
  console.log(`Test de charge — ${URL_API}`);
  console.log(`${REQUETES_TOTAL} requêtes par point d'accès, concurrence ${CONCURRENCE}`);

  const depart = performance.now();

  const sante = await vague(() => appeler('/api/v1/sante'), REQUETES_TOTAL, CONCURRENCE);
  resumer('GET /api/v1/sante (public)', sante);

  const referentiels = await vague(
    () => appeler('/api/v1/referentiels/fiscaux?regime=REEL_SIMPLIFIE'),
    REQUETES_TOTAL,
    CONCURRENCE,
  );
  resumer('GET /api/v1/referentiels/fiscaux (public)', referentiels);

  const jeton = await obtenirJeton();
  if (jeton) {
    const kpis = await vague(
      () => appeler('/api/v1/kpis/entreprise', { headers: { Authorization: `Bearer ${jeton}` } }),
      REQUETES_TOTAL,
      CONCURRENCE,
    );
    resumer('GET /api/v1/kpis/entreprise (authentifié)', kpis);
  } else {
    console.log(
      '\n(GET /api/v1/kpis/entreprise ignoré : définissez FNEPLUS_JETON_TEST pour inclure le chemin authentifié.)',
    );
  }

  const dureeTotale = (performance.now() - depart) / 1000;
  console.log(`\nTerminé en ${dureeTotale.toFixed(1)} s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
