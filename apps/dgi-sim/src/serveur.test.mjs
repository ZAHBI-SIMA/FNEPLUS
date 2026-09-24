/**
 * Tests du simulateur DGI.
 *
 * Ils vérifient surtout les comportements dont dépend le connecteur : rejet
 * lisible, idempotence, détection de doublon de numéro.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '4099';
const { serveur } = await import('./serveur.mjs');

const BASE = 'http://localhost:4099';

/** Schéma sortant, tel que le produit la couche d'anticorruption. */
const factureValide = (numero = 'ABJ01-2026-000001') => ({
  id: `fac-${numero}`,
  entrepriseId: 'ent-test',
  ncc: 'CI-TEST-0000001',
  numero,
  dateEmission: '2026-06-15T09:00:00.000Z',
  lignes: [
    { designation: 'Article', quantite: 1, prixUnitaireHT: 1000, codeTaxation: 'TVA_NORMAL' },
  ],
  totaux: { totalHT: 1000, totalTVA: 180, totalTTC: 1180 },
  empreinte: 'a'.repeat(64),
  versionMapping: '2026.01',
});

async function poster(facture, entetes = {}) {
  const reponse = await fetch(`${BASE}/api/v1/factures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...entetes },
    body: JSON.stringify({ facture }),
  });
  return { statut: reponse.status, corps: await reponse.json(), entetes: reponse.headers };
}

before(async () => {
  await new Promise((r) => {
    if (serveur.listening) r();
    else serveur.once('listening', r);
  });
});

after(() => serveur.close());

describe('enregistrement d’une facture', () => {
  it('certifie une facture valide', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    const { statut, corps } = await poster(factureValide());

    assert.equal(statut, 201);
    assert.equal(corps.statut, 'CERTIFIEE');
    assert.match(corps.identifiantCertification, /^DGI-\d{4}-[0-9A-F]{8}$/);
    assert.ok(corps.contenuQR.includes('ABJ01-2026-000001'));
  });

  it('rejette une facture sans ligne, avec un motif lisible', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    const { statut, corps } = await poster({ ...factureValide(), lignes: [] });

    assert.equal(statut, 422);
    assert.equal(corps.statut, 'REJETEE');
    assert.ok(corps.motifs.some((m) => m.includes('aucune ligne')));
  });

  it('rejette un numéro déjà transmis', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    await poster(factureValide('ABJ01-2026-000042'));
    const { statut, corps } = await poster(factureValide('ABJ01-2026-000042'));

    assert.equal(statut, 422);
    assert.ok(corps.motifs.some((m) => m.includes('déjà été transmis')));
  });
});

describe('idempotence', () => {
  it('renvoie la même réponse pour une clé rejouée, sans créer de doublon', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    const cle = { 'Idempotency-Key': 'cle-test-1' };

    const premier = await poster(factureValide('ABJ01-2026-000100'), cle);
    const second = await poster(factureValide('ABJ01-2026-000100'), cle);

    assert.equal(premier.statut, 201);
    assert.equal(second.statut, 201);
    assert.equal(
      premier.corps.identifiantCertification,
      second.corps.identifiantCertification,
      'un rejeu doit rendre le même identifiant de certification',
    );
    assert.equal(second.entetes.get('idempotent-replay'), 'true');
  });
});

describe('panneau de contrôle', () => {
  it('applique une latence configurée', async () => {
    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latenceMs: 150 }),
    });

    const depart = Date.now();
    await fetch(`${BASE}/api/v1/factures/inexistante`);
    const duree = Date.now() - depart;

    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latenceMs: 0 }),
    });

    assert.ok(duree >= 150, `latence attendue ≥ 150 ms, mesurée ${duree} ms`);
  });

  it('reste joignable même quand la panne totale est activée', async () => {
    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panne: true }),
    });

    // Le panneau de contrôle échappe au chaos, sinon on ne pourrait plus
    // désactiver la panne.
    const config = await fetch(`${BASE}/_simulateur/config`);
    assert.equal(config.status, 200);

    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panne: false }),
    });
  });
});
