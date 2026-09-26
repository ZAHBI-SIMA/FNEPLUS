/**
 * Tests d'intégration des indicateurs de succès (chapitre 10 du CDC).
 *
 * Ce que ces tests protègent : un pourcentage ne doit jamais être calculé sur
 * un dénominateur nul (une entreprise toute neuve, sans facture, ne doit pas
 * faire planter son propre tableau de bord), l'indicateur plateforme ne doit
 * être lisible qu'avec le jeton d'exploitation, et l'isolation entre
 * entreprises doit tenir même sur un calcul agrégé.
 *
 * Prérequis : `pnpm infra:up`, `pnpm --filter @fneplus/api migrer`.
 */

import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres from 'postgres';
import { uuidv7 } from '@fneplus/core';
import { AppModule } from '../app.module.js';
import { SmsService } from '../auth/sms.service.js';

const URL_ADMIN =
  process.env['DATABASE_URL_ADMIN'] ?? 'postgres://fneplus:fneplus_dev@localhost:5435/fneplus';
const JETON_OPERATEUR = process.env['KPI_JETON_OPERATEUR'] ?? 'jeton-operateur-de-developpement';

let app: NestFastifyApplication;
let admin: postgres.Sql;
let sms: SmsService;

async function appeler(
  methode: 'GET' | 'POST',
  url: string,
  options: { corps?: unknown; jeton?: string; entetes?: Record<string, string> } = {},
) {
  const reponse = await app.inject({
    method: methode,
    url,
    ...(options.corps !== undefined ? { payload: options.corps as object } : {}),
    headers: {
      ...(options.jeton ? { authorization: `Bearer ${options.jeton}` } : {}),
      ...(options.entetes ?? {}),
    },
  });
  return {
    statut: reponse.statusCode,
    corps: reponse.body ? (JSON.parse(reponse.body) as Record<string, unknown>) : null,
  };
}

async function preparerEntreprise(suffixe: string) {
  const telephone = `+2250790000${suffixe.padStart(3, '0')}`;
  const inscription = await appeler('POST', '/api/v1/entreprises/inscription', {
    corps: {
      ncc: `CI-KPI-${suffixe}`,
      raisonSociale: `Boutique KPI ${suffixe}`,
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

  const terminalId = uuidv7();
  await admin`
    INSERT INTO terminaux (id, entreprise_id, point_de_vente_id, libelle)
    VALUES (${terminalId}, ${entrepriseId}, ${pointDeVenteId}, 'Caisse test')
  `;

  return { jeton: connexion.corps!['jeton'] as string, entrepriseId, pointDeVenteId, terminalId };
}

/**
 * Pose une facture directement en base, avec un délai de synchronisation et un
 * état de transmission choisis — plutôt que de rejouer toute la chaîne
 * d'émission et le connecteur DGI, déjà couverts ailleurs.
 */
async function poserFacture(
  ctx: { entrepriseId: string; pointDeVenteId: string; terminalId: string },
  options: {
    numero: string;
    /** Écart entre l'émission et la réception serveur, en secondes. */
    delaiSyncSecondes?: number;
    etatTransmission?: 'EN_ATTENTE' | 'CERTIFIEE' | 'REJETEE';
    /** Écart entre l'émission et la fin de transmission, en heures. */
    delaiTransmissionHeures?: number;
  },
) {
  const factureId = uuidv7();
  const emiseLe = new Date(Date.now() - 3_600_000);
  const recueLe = new Date(emiseLe.getTime() + (options.delaiSyncSecondes ?? 1) * 1000);

  await admin`
    INSERT INTO factures (
      id, entreprise_id, point_de_vente_id, terminal_id, type, statut, numero,
      emise_le, recue_le, client_nom, total_ht, total_tva, total_ttc, totaux, lignes,
      version_referentiel, hash_precedent, hash
    ) VALUES (
      ${factureId}, ${ctx.entrepriseId}, ${ctx.pointDeVenteId}, ${ctx.terminalId}, 'FACTURE',
      'EMISE_LOCALEMENT', ${options.numero}, ${emiseLe.toISOString()}, ${recueLe.toISOString()},
      'Client test', 10000, 1800, 11800, '{}'::jsonb, '[]'::jsonb,
      '2026.01', ${'0'.repeat(64)}, ${'hash-' + factureId}
    )
  `;

  if (options.etatTransmission) {
    const termineeLe = new Date(
      emiseLe.getTime() + (options.delaiTransmissionHeures ?? 1) * 3_600_000,
    );
    await admin`
      INSERT INTO file_transmission (facture_id, entreprise_id, etat, terminee_le)
      VALUES (${factureId}, ${ctx.entrepriseId}, ${options.etatTransmission}, ${termineeLe.toISOString()})
    `;
  }

  return factureId;
}

beforeAll(async () => {
  admin = postgres(URL_ADMIN, { max: 2, onnotice: () => {} });

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

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

describe('KPI par entreprise', () => {
  it('renvoie des indicateurs à zéro plutôt qu’une erreur, sans facture', async () => {
    const { jeton } = await preparerEntreprise('1');
    const reponse = await appeler('GET', '/api/v1/kpis/entreprise', { jeton });

    expect(reponse.statut).toBe(200);
    expect(reponse.corps!['usage']).toMatchObject({
      nombreFactures: 0,
      partHorsLignePourcent: null,
      delaiMoyenSyncSecondes: null,
    });
    expect(reponse.corps!['conformite']).toMatchObject({
      nombreCertifiees: 0,
      partDansLeDelaiPourcent: null,
    });
  });

  it('distingue une facture synchronisée aussitôt d’une facture restée hors ligne', async () => {
    const ctx = await preparerEntreprise('2');
    await poserFacture(ctx, { numero: 'F1', delaiSyncSecondes: 2 }); // en ligne
    await poserFacture(ctx, { numero: 'F2', delaiSyncSecondes: 3 * 3600 }); // resté hors ligne 3 h

    const reponse = await appeler('GET', '/api/v1/kpis/entreprise', { jeton: ctx.jeton });

    expect(reponse.corps!['usage']).toMatchObject({ nombreFactures: 2, partHorsLignePourcent: 50 });
  });

  it('mesure la part des factures certifiées dans le délai réglementaire', async () => {
    const ctx = await preparerEntreprise('3');
    // Délai réglementaire par défaut : 24 h.
    await poserFacture(ctx, {
      numero: 'F1',
      etatTransmission: 'CERTIFIEE',
      delaiTransmissionHeures: 2,
    });
    await poserFacture(ctx, {
      numero: 'F2',
      etatTransmission: 'CERTIFIEE',
      delaiTransmissionHeures: 48,
    });
    await poserFacture(ctx, { numero: 'F3', etatTransmission: 'EN_ATTENTE' }); // pas encore transmise

    const reponse = await appeler('GET', '/api/v1/kpis/entreprise', { jeton: ctx.jeton });

    expect(reponse.corps!['conformite']).toMatchObject({
      nombreCertifiees: 2,
      partDansLeDelaiPourcent: 50,
    });
  });

  it('n’expose que les factures de l’entreprise connectée', async () => {
    const a = await preparerEntreprise('4');
    const b = await preparerEntreprise('5');
    await poserFacture(a, { numero: 'F1' });
    await poserFacture(a, { numero: 'F2' });
    await poserFacture(b, { numero: 'F1' });

    const reponseA = await appeler('GET', '/api/v1/kpis/entreprise', { jeton: a.jeton });
    const reponseB = await appeler('GET', '/api/v1/kpis/entreprise', { jeton: b.jeton });

    expect((reponseA.corps!['usage'] as { nombreFactures: number }).nombreFactures).toBe(2);
    expect((reponseB.corps!['usage'] as { nombreFactures: number }).nombreFactures).toBe(1);
  });

  it('refuse l’accès sans authentification', async () => {
    const reponse = await appeler('GET', '/api/v1/kpis/entreprise');
    expect(reponse.statut).toBe(401);
  });
});

describe('KPI plateforme', () => {
  it('refuse l’accès sans le jeton d’exploitation', async () => {
    const sansJeton = await appeler('GET', '/api/v1/kpis/plateforme');
    expect(sansJeton.statut).toBe(401);

    const mauvaisJeton = await appeler('GET', '/api/v1/kpis/plateforme', {
      entetes: { 'x-jeton-operateur': 'faux-jeton' },
    });
    expect(mauvaisJeton.statut).toBe(401);
  });

  it('agrège l’usage à travers toutes les entreprises', async () => {
    const a = await preparerEntreprise('6');
    const b = await preparerEntreprise('7');
    await poserFacture(a, { numero: 'F1' });
    await poserFacture(b, { numero: 'F1' });
    await poserFacture(b, { numero: 'F2' });

    const reponse = await appeler('GET', '/api/v1/kpis/plateforme', {
      entetes: { 'x-jeton-operateur': JETON_OPERATEUR },
    });

    expect(reponse.statut).toBe(200);
    expect(reponse.corps!['adoption']).toMatchObject({ entreprisesInscritesTotal: 2 });
    expect((reponse.corps!['usage'] as { nombreFactures: number }).nombreFactures).toBe(3);
    // Aucune source de données : le champ le dit, plutôt que d'inventer un chiffre.
    expect(reponse.corps!['satisfaction']).toBeNull();
    expect(reponse.corps!['satisfactionNote']).toEqual(expect.any(String));
  });
});
