/**
 * Tests du simulateur mobile money.
 *
 * Vérifient ce dont dépend le connecteur : idempotence de la demande, refus
 * lisible, et surtout que le webhook envoyé est bien signé — c'est cette
 * signature que le connecteur doit vérifier avant de créditer quoi que ce soit.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.PORT = '4098';
process.env.MOMO_SECRET = 'secret-de-test';
const { serveur, chaos, signer } = await import('./serveur.mjs');

const BASE = 'http://localhost:4098';

const demande = (referenceExterne = 'fac-test-1') => ({
  montant: 1_180,
  operateur: 'ORANGE_MONEY',
  referenceExterne,
  telephone: '+2250700000000',
});

before(async () => {
  await new Promise((r) => {
    if (serveur.listening) r();
    else serveur.once('listening', r);
  });
});

after(() => serveur.close());

async function poster(corps) {
  const reponse = await fetch(`${BASE}/api/v1/paiements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });
  return { statut: reponse.status, corps: await reponse.json(), entetes: reponse.headers };
}

describe('création de demande', () => {
  it('crée une demande et rend un lien de paiement', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    const { statut, corps } = await poster(demande());

    assert.equal(statut, 201);
    assert.equal(corps.statut, 'EN_ATTENTE');
    assert.match(corps.lienPaiement, /^http:\/\/localhost:4098\/payer\//);
  });

  it('rejette un montant non entier', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    const { statut, corps } = await poster({ ...demande(), montant: 1000.5 });

    assert.equal(statut, 422);
    assert.ok(corps.motifs.some((m) => m.includes('décimale')));
  });

  it('rejette un opérateur inconnu', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    const { statut } = await poster({ ...demande(), operateur: 'BITCOIN' });
    assert.equal(statut, 422);
  });

  it('ne recrée pas une demande déjà ouverte pour la même facture', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    const premiere = await poster(demande('fac-idempotence'));
    const seconde = await poster(demande('fac-idempotence'));

    assert.equal(premiere.corps.reference, seconde.corps.reference);
    assert.equal(seconde.entetes.get('idempotent-replay'), 'true');
  });
});

describe('confirmation et webhook', () => {
  it('notifie le webhook avec une signature vérifiable', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaiWebhookMs: 10 }),
    });

    // Petit serveur qui joue le rôle de notre webhook.
    let recu = null;
    const ecouteur = createServer(async (req, res) => {
      const morceaux = [];
      for await (const m of req) morceaux.push(m);
      recu = { corps: Buffer.concat(morceaux).toString('utf8'), signature: req.headers['x-momo-signature'] };
      res.writeHead(200).end('ok');
    });
    await new Promise((r) => ecouteur.listen(4097, r));

    const { corps } = await poster({ ...demande('fac-webhook'), urlWebhook: 'http://localhost:4097/' });
    await fetch(`${BASE}/api/v1/paiements/${corps.reference}/confirmer`, { method: 'POST' });

    await new Promise((r) => setTimeout(r, 200));
    ecouteur.close();

    assert.ok(recu, 'le webhook doit avoir été appelé');
    const attendue = signer(JSON.parse(recu.corps));
    assert.equal(recu.signature, attendue);

    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaiWebhookMs: 500 }),
    });
  });

  it('produit une signature invalide quand le chaos le demande', async () => {
    await fetch(`${BASE}/_simulateur/reinitialiser`, { method: 'POST' });
    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaiWebhookMs: 10, signatureInvalide: true }),
    });

    let recu = null;
    const ecouteur = createServer(async (req, res) => {
      recu = req.headers['x-momo-signature'];
      res.writeHead(200).end('ok');
    });
    await new Promise((r) => ecouteur.listen(4096, r));

    const { corps } = await poster({ ...demande('fac-mauvaise-sig'), urlWebhook: 'http://localhost:4096/' });
    await fetch(`${BASE}/api/v1/paiements/${corps.reference}/confirmer`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 200));
    ecouteur.close();

    assert.equal(recu, 'signature-invalide');

    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaiWebhookMs: 500, signatureInvalide: false }),
    });
  });
});

describe('panneau de contrôle', () => {
  it('reste joignable pendant une coupure totale', async () => {
    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panne: true }),
    });
    const config = await fetch(`${BASE}/_simulateur/config`);
    assert.equal(config.status, 200);

    await fetch(`${BASE}/_simulateur/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panne: false }),
    });
  });
});
