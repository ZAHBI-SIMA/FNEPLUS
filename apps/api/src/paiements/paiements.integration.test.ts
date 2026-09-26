/**
 * Tests d'intégration de l'encaissement mobile money.
 *
 * Tournent contre un vrai PostgreSQL et le simulateur mobile money
 * (`apps/momo-sim`), dont le panneau de contrôle permet d'injecter latence,
 * erreurs, double envoi de webhook et signature invalide.
 *
 * Ce que ces tests protègent : une notification non signée ne doit jamais
 * créditer une facture, et une notification rejouée ne doit jamais créditer
 * deux fois. Ce sont les deux façons de perdre de l'argent en production.
 *
 * Prérequis : `pnpm infra:up`, `pnpm --filter @fneplus/api migrer`,
 * `pnpm --filter @fneplus/momo-sim dev`.
 */

import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres from 'postgres';
import { createHmac } from 'node:crypto';
import { uuidv7 } from '@fneplus/core';
import { AppModule } from '../app.module.js';
import { SmsService } from '../auth/sms.service.js';
import { PaiementsService } from './paiements.service.js';

const URL_ADMIN =
  process.env['DATABASE_URL_ADMIN'] ?? 'postgres://fneplus:fneplus_dev@localhost:5435/fneplus';
const URL_MOMO = process.env['MOMO_URL'] ?? 'http://localhost:4020';
const MOMO_SECRET = process.env['MOMO_SECRET'] ?? 'secret-momo-de-developpement';

let app: NestFastifyApplication;
let admin: postgres.Sql;
let paiements: PaiementsService;
let sms: SmsService;

async function configurerSimulateur(config: Record<string, unknown>): Promise<void> {
  await fetch(`${URL_MOMO}/_simulateur/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

async function reinitialiserSimulateur(): Promise<void> {
  await fetch(`${URL_MOMO}/_simulateur/reinitialiser`, { method: 'POST' });
  await configurerSimulateur({
    latenceMs: 0,
    tauxErreur: 0,
    delaiWebhookMs: 50,
    webhookEnDouble: false,
    signatureInvalide: false,
    panne: false,
  });
}

async function appeler(
  methode: 'GET' | 'POST',
  url: string,
  options: { corps?: unknown; jeton?: string } = {},
) {
  const reponse = await app.inject({
    method: methode,
    url,
    ...(options.corps !== undefined ? { payload: options.corps as object } : {}),
    headers: options.jeton ? { authorization: `Bearer ${options.jeton}` } : {},
  });
  return {
    statut: reponse.statusCode,
    corps: reponse.body ? (JSON.parse(reponse.body) as Record<string, unknown>) : null,
  };
}

/** Inscrit une entreprise, ouvre une session, et pose une facture directement en base. */
async function preparerFacture(suffixe: string, totalTTC = 11_800) {
  const telephone = `+2250780000${suffixe.padStart(3, '0')}`;

  const inscription = await appeler('POST', '/api/v1/entreprises/inscription', {
    corps: {
      ncc: `CI-MOMO-${suffixe}`,
      raisonSociale: `Boutique Momo ${suffixe}`,
      regimeFiscal: 'REEL_SIMPLIFIE',
      telephone,
      nomProprietaire: 'Responsable',
    },
  });
  const entrepriseId = inscription.corps!['entrepriseId'] as string;
  const pointDeVenteId = inscription.corps!['pointDeVenteId'] as string;

  await appeler('POST', '/api/v1/auth/demander-code', { corps: { telephone } });
  const code = sms.envoyes.at(-1)?.contenu.match(/\b(\d{6})\b/)?.[1];
  const connexion = await appeler('POST', '/api/v1/auth/verifier-code', {
    corps: { telephone, code },
  });
  const jeton = connexion.corps!['jeton'] as string;

  const terminalId = uuidv7();
  const factureId = uuidv7();

  await admin`
    INSERT INTO terminaux (id, entreprise_id, point_de_vente_id, libelle)
    VALUES (${terminalId}, ${entrepriseId}, ${pointDeVenteId}, 'Caisse test')
  `;
  await admin`
    INSERT INTO factures (
      id, entreprise_id, point_de_vente_id, terminal_id, type, statut, numero,
      emise_le, client_nom, total_ht, total_tva, total_ttc, totaux, lignes,
      version_referentiel, hash_precedent, hash
    ) VALUES (
      ${factureId}, ${entrepriseId}, ${pointDeVenteId}, ${terminalId}, 'FACTURE', 'EN_FILE_DGI',
      ${`FAC-${suffixe}`}, now(), 'Client test', ${Math.round(totalTTC / 1.18)},
      ${totalTTC - Math.round(totalTTC / 1.18)}, ${totalTTC}, '{}'::jsonb, '[]'::jsonb,
      '2026.01', ${'0'.repeat(64)}, ${'hash-test'}
    )
  `;

  return { jeton, entrepriseId, factureId, totalTTC };
}

beforeAll(async () => {
  // Les colonnes BIGINT (montant_regle, total_ttc…) reviennent en chaîne par
  // défaut avec `postgres` : ce parseur les rend en nombre JS, comme le fait la
  // connexion applicative de production (`db.module.ts`).
  admin = postgres(URL_ADMIN, {
    max: 2,
    onnotice: () => {},
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
    },
  });

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    rawBody: true,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  paiements = app.get(PaiementsService);
  sms = app.get(SmsService);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await reinitialiserSimulateur().catch(() => {});
});

beforeEach(async () => {
  await admin`TRUNCATE entreprises, codes_otp RESTART IDENTITY CASCADE`;
  sms.envoyes.length = 0;
  await reinitialiserSimulateur();
});

/* ------------------------------------------------------------------ */

describe('encaissement en espèces', () => {
  it('règle la facture immédiatement, sans prestataire externe', async () => {
    const { jeton, factureId, totalTTC } = await preparerFacture('1');

    const reponse = await appeler('POST', '/api/v1/paiements', {
      corps: { factureId, moyen: 'ESPECES', montant: totalTTC },
      jeton,
    });

    expect(reponse.statut).toBe(201);
    expect(reponse.corps!['statut']).toBe('REGLEE');

    const [facture] = await admin<{ montant_regle: number; reglee_le: Date | null }[]>`
      SELECT montant_regle, reglee_le FROM factures WHERE id = ${factureId}
    `;
    expect(facture!.montant_regle).toBe(totalTTC);
    expect(facture!.reglee_le).not.toBeNull();
  });

  it('accepte un règlement partiel et garde la facture ouverte', async () => {
    const { jeton, factureId, totalTTC } = await preparerFacture('2');

    await appeler('POST', '/api/v1/paiements', {
      corps: { factureId, moyen: 'ESPECES', montant: Math.floor(totalTTC / 2) },
      jeton,
    });

    const [facture] = await admin<{ montant_regle: number; reglee_le: Date | null }[]>`
      SELECT montant_regle, reglee_le FROM factures WHERE id = ${factureId}
    `;
    expect(facture!.montant_regle).toBe(Math.floor(totalTTC / 2));
    expect(facture!.reglee_le).toBeNull();
  });

  it('refuse un montant qui dépasse ce qui reste à devoir', async () => {
    const { jeton, factureId, totalTTC } = await preparerFacture('3');

    const reponse = await appeler('POST', '/api/v1/paiements', {
      corps: { factureId, moyen: 'ESPECES', montant: totalTTC + 1000 },
      jeton,
    });

    expect(reponse.statut).toBeGreaterThanOrEqual(400);
  });
});

/* ------------------------------------------------------------------ */

describe('encaissement mobile money — rapprochement automatique', () => {
  it('règle la facture quand le webhook signé arrive', async () => {
    const { jeton, factureId, totalTTC } = await preparerFacture('4');

    const demande = await appeler('POST', '/api/v1/paiements', {
      corps: { factureId, moyen: 'ORANGE_MONEY', montant: totalTTC, telephone: '+2250700000000' },
      jeton,
    });
    expect(demande.statut).toBe(201);
    expect(demande.corps!['statut']).toBe('EN_ATTENTE');
    const reference = demande.corps!['reference'] as string;

    // Le client règle depuis son propre téléphone : on simule cette action en
    // appelant directement le simulateur, comme le ferait l'agrégateur.
    await fetch(`${URL_MOMO}/api/v1/paiements/${reference}/confirmer`, { method: 'POST' });

    // Le webhook est asynchrone côté simulateur : on laisse le temps d'arriver.
    await new Promise((r) => setTimeout(r, 400));

    const [facture] = await admin<{ montant_regle: number }[]>`
      SELECT montant_regle FROM factures WHERE id = ${factureId}
    `;
    expect(facture!.montant_regle).toBe(totalTTC);
  }, 15_000);

  it('ignore une notification dont la signature ne correspond pas', async () => {
    const { jeton, factureId, totalTTC } = await preparerFacture('5');

    const demande = await appeler('POST', '/api/v1/paiements', {
      corps: { factureId, moyen: 'WAVE', montant: totalTTC },
      jeton,
    });
    const reference = demande.corps!['reference'] as string;

    const corpsBrut = JSON.stringify({
      reference,
      referenceExterne: demande.corps!['id'],
      statut: 'REGLEE',
      montant: totalTTC,
      operateur: 'WAVE',
    });

    const resultat = await paiements.traiterNotification(
      corpsBrut,
      'signature-fabriquee-a-la-main',
    );
    expect(resultat.accepte).toBe(false);

    const [facture] = await admin<{ montant_regle: number }[]>`
      SELECT montant_regle FROM factures WHERE id = ${factureId}
    `;
    expect(facture!.montant_regle).toBe(0);
  });

  it('ne crédite qu’une fois quand le webhook est reçu deux fois', async () => {
    const { jeton, factureId, totalTTC } = await preparerFacture('6');

    const demande = await appeler('POST', '/api/v1/paiements', {
      corps: { factureId, moyen: 'MTN_MOMO', montant: totalTTC },
      jeton,
    });
    const referenceExterne = demande.corps!['id'] as string;
    const reference = demande.corps!['reference'] as string;

    const notification = {
      reference,
      referenceExterne,
      statut: 'REGLEE',
      montant: totalTTC,
      operateur: 'MTN_MOMO',
      regleLe: new Date().toISOString(),
    };
    const corpsBrut = JSON.stringify(notification);
    const signature = createHmac('sha256', MOMO_SECRET).update(corpsBrut).digest('hex');

    const premier = await paiements.traiterNotification(corpsBrut, signature);
    const second = await paiements.traiterNotification(corpsBrut, signature);

    expect(premier.accepte).toBe(true);
    expect(second.accepte).toBe(true);

    const [facture] = await admin<{ montant_regle: number }[]>`
      SELECT montant_regle FROM factures WHERE id = ${factureId}
    `;
    // Rejoué deux fois, crédité une seule : c'est tout l'enjeu du test.
    expect(facture!.montant_regle).toBe(totalTTC);
  });

  it('encaisse malgré un webhook envoyé en double par l’agrégateur', async () => {
    const { jeton, factureId, totalTTC } = await preparerFacture('7');
    await configurerSimulateur({ webhookEnDouble: true, delaiWebhookMs: 50 });

    const demande = await appeler('POST', '/api/v1/paiements', {
      corps: { factureId, moyen: 'ORANGE_MONEY', montant: totalTTC },
      jeton,
    });
    const reference = demande.corps!['reference'] as string;

    await fetch(`${URL_MOMO}/api/v1/paiements/${reference}/confirmer`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 600));

    const [facture] = await admin<{ montant_regle: number }[]>`
      SELECT montant_regle FROM factures WHERE id = ${factureId}
    `;
    expect(facture!.montant_regle).toBe(totalTTC);
  }, 15_000);
});
