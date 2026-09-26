/**
 * Tests d'intégration du suivi ARF.
 *
 * Ce qui compte : le statut change de ton AVANT l'expiration, pas seulement le
 * jour même — c'est explicitement l'exigence du cahier des charges.
 */

import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres from 'postgres';
import { AppModule } from '../app.module.js';
import { SmsService } from '../auth/sms.service.js';
import { ArfService } from './arf.module.js';

const URL_ADMIN =
  process.env['DATABASE_URL_ADMIN'] ?? 'postgres://fneplus:fneplus_dev@localhost:5435/fneplus';

let app: NestFastifyApplication;
let admin: postgres.Sql;
let arf: ArfService;
let sms: SmsService;

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

async function preparerEntreprise(suffixe: string) {
  const telephone = `+2250770000${suffixe.padStart(3, '0')}`;
  const inscription = await appeler('POST', '/api/v1/entreprises/inscription', {
    corps: {
      ncc: `CI-ARF-${suffixe}`,
      raisonSociale: `Boutique ARF ${suffixe}`,
      regimeFiscal: 'REEL_SIMPLIFIE',
      telephone,
      nomProprietaire: 'Responsable',
    },
  });
  await appeler('POST', '/api/v1/auth/demander-code', { corps: { telephone } });
  const code = sms.envoyes.at(-1)?.contenu.match(/\b(\d{6})\b/)?.[1];
  const connexion = await appeler('POST', '/api/v1/auth/verifier-code', {
    corps: { telephone, code },
  });
  return {
    jeton: connexion.corps!['jeton'] as string,
    entrepriseId: inscription.corps!['entrepriseId'] as string,
  };
}

const jourDecale = (jours: number) => {
  const d = new Date();
  d.setDate(d.getDate() + jours);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  admin = postgres(URL_ADMIN, { max: 2, onnotice: () => {} });
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  arf = app.get(ArfService);
  sms = app.get(SmsService);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

beforeEach(async () => {
  await admin`TRUNCATE entreprises, codes_otp RESTART IDENTITY CASCADE`;
  sms.envoyes.length = 0;
});

describe('situation ARF', () => {
  it('signale l’absence d’attestation par défaut', async () => {
    const { entrepriseId } = await preparerEntreprise('1');
    const situation = await arf.situation(entrepriseId);
    expect(situation.statut).toBe('AUCUNE');
  });

  it('est à jour loin de l’échéance', async () => {
    const { entrepriseId } = await preparerEntreprise('2');
    await arf.enregistrer(entrepriseId, {
      numero: 'ARF-2026-001',
      delivreeLe: jourDecale(-30),
      expireLe: jourDecale(200),
    });

    const situation = await arf.situation(entrepriseId);
    expect(situation.statut).toBe('A_JOUR');
  });

  it('alerte AVANT l’expiration, pas seulement le jour même', async () => {
    const { entrepriseId } = await preparerEntreprise('3');
    await arf.enregistrer(entrepriseId, {
      delivreeLe: jourDecale(-300),
      expireLe: jourDecale(10),
    });

    const situation = await arf.situation(entrepriseId);
    expect(situation.statut).toBe('BIENTOT_EXPIREE');
    expect(situation.joursAvantExpiration).toBeLessThanOrEqual(30);
    expect(situation.message).toMatch(/renouvelez/i);
  });

  it('signale une expiration dépassée', async () => {
    const { entrepriseId } = await preparerEntreprise('4');
    await arf.enregistrer(entrepriseId, {
      delivreeLe: jourDecale(-400),
      expireLe: jourDecale(-5),
    });

    const situation = await arf.situation(entrepriseId);
    expect(situation.statut).toBe('EXPIREE');
    expect(situation.message).toMatch(/bloqué/i);
  });

  it('retient la révocation même si la date d’expiration n’est pas dépassée', async () => {
    const { entrepriseId } = await preparerEntreprise('5');
    await arf.enregistrer(entrepriseId, { delivreeLe: jourDecale(-10), expireLe: jourDecale(300) });
    await arf.revoquer(entrepriseId, 'Contrôle en cours');

    const situation = await arf.situation(entrepriseId);
    expect(situation.statut).toBe('REVOQUEE');
  });

  it('isole la situation ARF entre deux entreprises', async () => {
    const a = await preparerEntreprise('6');
    const b = await preparerEntreprise('7');
    await arf.enregistrer(a.entrepriseId, {
      delivreeLe: jourDecale(-10),
      expireLe: jourDecale(300),
    });

    const situationA = await arf.situation(a.entrepriseId);
    const situationB = await arf.situation(b.entrepriseId);
    expect(situationA.statut).toBe('A_JOUR');
    expect(situationB.statut).toBe('AUCUNE');
  });

  it('expose la situation par l’API, protégée par authentification', async () => {
    const { jeton } = await preparerEntreprise('8');

    const sansJeton = await appeler('GET', '/api/v1/arf/situation');
    expect(sansJeton.statut).toBe(401);

    const avecJeton = await appeler('GET', '/api/v1/arf/situation', { jeton });
    expect(avecJeton.statut).toBe(200);
    expect(avecJeton.corps!['statut']).toBe('AUCUNE');
  });
});
