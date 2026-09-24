/**
 * Tests d'intégration de l'API.
 *
 * Ils tournent contre un vrai PostgreSQL : l'isolation multi-tenant repose sur
 * Row Level Security, et une base simulée ne prouverait rien de ce qui compte
 * ici. C'est aussi ce qui permet de vérifier l'idempotence réelle de la
 * synchronisation plutôt que celle d'un test double.
 *
 * Prérequis : `pnpm infra:up` puis `pnpm --filter @fneplus/api migrer`.
 */

import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres from 'postgres';
import { uuidv7 } from '@fneplus/core';
import { AppModule } from './app.module.js';
import { SmsService } from './auth/sms.service.js';

const URL_ADMIN =
  process.env.DATABASE_URL_ADMIN ?? 'postgres://fneplus:fneplus_dev@localhost:5435/fneplus';

let app: NestFastifyApplication;
let sms: SmsService;
let admin: postgres.Sql;

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

/** Parcours complet : inscription, code SMS, session. */
async function inscrireEtConnecter(suffixe: string) {
  const telephone = `+2250700000${suffixe.padStart(3, '0')}`;

  const inscription = await appeler('POST', '/api/v1/entreprises/inscription', {
    corps: {
      ncc: `CI-TEST-${suffixe}`,
      raisonSociale: `Boutique ${suffixe}`,
      regimeFiscal: 'REEL_SIMPLIFIE',
      telephone,
      nomProprietaire: 'Responsable test',
      adresse: 'Abidjan',
    },
  });
  expect(inscription.statut).toBe(201);

  await appeler('POST', '/api/v1/auth/demander-code', { corps: { telephone } });
  const message = sms.envoyes.at(-1);
  const code = message?.contenu.match(/\b(\d{6})\b/)?.[1];
  expect(code, 'un code à 6 chiffres doit avoir été envoyé par SMS').toBeDefined();

  const connexion = await appeler('POST', '/api/v1/auth/verifier-code', {
    corps: { telephone, code },
  });
  expect(connexion.statut).toBe(200);

  return {
    telephone,
    jeton: connexion.corps!['jeton'] as string,
    entrepriseId: inscription.corps!['entrepriseId'] as string,
    pointDeVenteId: inscription.corps!['pointDeVenteId'] as string,
  };
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
  // TRUNCATE avec le rôle propriétaire, qui contourne la RLS. CASCADE parce que
  // tout est rattaché aux entreprises par clé étrangère.
  await admin`
    TRUNCATE entreprises, codes_otp RESTART IDENTITY CASCADE
  `;
  sms.envoyes.length = 0;
});

describe('inscription et connexion', () => {
  it('inscrit une entreprise puis ouvre une session par code SMS', async () => {
    const { jeton, entrepriseId } = await inscrireEtConnecter('1');

    const moi = await appeler('GET', '/api/v1/entreprises/moi', { jeton });
    expect(moi.statut).toBe(200);
    expect(moi.corps!['id']).toBe(entrepriseId);
    expect(moi.corps!['regimeFiscal']).toBe('REEL_SIMPLIFIE');
    expect((moi.corps!['pointsDeVente'] as unknown[]).length).toBe(1);
  });

  it('refuse un NCC déjà inscrit', async () => {
    await inscrireEtConnecter('2');

    const doublon = await appeler('POST', '/api/v1/entreprises/inscription', {
      corps: {
        ncc: 'CI-TEST-2',
        raisonSociale: 'Autre boutique',
        regimeFiscal: 'REEL_NORMAL',
        telephone: '+2250799999999',
        nomProprietaire: 'Quelqu’un d’autre',
      },
    });

    expect(doublon.statut).toBe(409);
    expect(doublon.corps!['code']).toBe('NCC_DEJA_INSCRIT');
  });

  it('ne révèle pas si un numéro correspond à un compte', async () => {
    const inconnu = await appeler('POST', '/api/v1/auth/demander-code', {
      corps: { telephone: '+2250712345678' },
    });

    expect(inconnu.statut).toBe(202);
    expect(sms.envoyes).toHaveLength(0);
  });

  it('refuse un code SMS erroné', async () => {
    const { telephone } = await inscrireEtConnecter('3');

    const refus = await appeler('POST', '/api/v1/auth/verifier-code', {
      corps: { telephone, code: '000000' },
    });

    expect(refus.statut).toBe(401);
  });

  it('permet de définir un PIN puis de se reconnecter avec', async () => {
    const { telephone, jeton } = await inscrireEtConnecter('4');

    const definition = await appeler('POST', '/api/v1/auth/definir-pin', {
      corps: { pin: '4921' },
      jeton,
    });
    expect(definition.statut).toBe(204);

    const parPin = await appeler('POST', '/api/v1/auth/connexion-pin', {
      corps: { telephone, pin: '4921' },
    });
    expect(parPin.statut).toBe(200);
    expect(parPin.corps!['definirPin']).toBe(false);

    const mauvais = await appeler('POST', '/api/v1/auth/connexion-pin', {
      corps: { telephone, pin: '0000' },
    });
    expect(mauvais.statut).toBe(401);
  });

  it('exige un jeton sur les routes protégées', async () => {
    const sansJeton = await appeler('GET', '/api/v1/entreprises/moi');
    expect(sansJeton.statut).toBe(401);
  });
});

describe('terminaux et plages de numéros', () => {
  it('appaire un terminal et lui alloue une réserve de numéros', async () => {
    const { jeton, pointDeVenteId } = await inscrireEtConnecter('5');

    const appairage = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId, libelle: 'Téléphone de la caisse', empreinte: 'appareil-abc' },
      jeton,
    });
    expect(appairage.statut).toBe(201);
    const terminalId = appairage.corps!['terminalId'] as string;

    const plage = await appeler('POST', `/api/v1/terminaux/${terminalId}/plages`, { jeton });
    expect(plage.statut).toBe(201);
    expect(plage.corps!['debut']).toBe(1);
    expect(plage.corps!['fin']).toBe(500);
    expect(plage.corps!['prefixe']).toBe(`PDV01-${new Date().getFullYear()}`);
  });

  it('retrouve le même terminal après réinstallation, sans consommer de plage', async () => {
    const { jeton, pointDeVenteId } = await inscrireEtConnecter('6');

    const premier = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId, libelle: 'Caisse 1', empreinte: 'empreinte-stable' },
      jeton,
    });
    const second = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId, libelle: 'Caisse 1', empreinte: 'empreinte-stable' },
      jeton,
    });

    expect(second.corps!['terminalId']).toBe(premier.corps!['terminalId']);
  });

  it('alloue des plages disjointes à deux terminaux du même point de vente', async () => {
    const { jeton, pointDeVenteId } = await inscrireEtConnecter('7');

    const creer = async (libelle: string) => {
      const t = await appeler('POST', '/api/v1/terminaux/appairage', {
        corps: { pointDeVenteId, libelle },
        jeton,
      });
      return appeler('POST', `/api/v1/terminaux/${t.corps!['terminalId'] as string}/plages`, {
        jeton,
      });
    };

    const a = await creer('Caisse A');
    const b = await creer('Caisse B');

    expect(a.corps!['debut']).toBe(1);
    expect(a.corps!['fin']).toBe(500);
    expect(b.corps!['debut']).toBe(501);
    expect(b.corps!['fin']).toBe(1000);
  });
});

describe('synchronisation', () => {
  async function contexteTerminal(suffixe: string) {
    const compte = await inscrireEtConnecter(suffixe);
    const appairage = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId: compte.pointDeVenteId, libelle: 'Caisse' },
      jeton: compte.jeton,
    });
    return { ...compte, terminalId: appairage.corps!['terminalId'] as string };
  }

  const commandeClient = (
    entrepriseId: string,
    terminalId: string,
    nom: string,
    murale = Date.now(),
    clientId = uuidv7(),
    commandeId = uuidv7(),
  ) => ({
    id: commandeId,
    type: 'UPSERT_CLIENT' as const,
    entrepriseId,
    terminalId,
    hlc: { murale, compteur: 0, noeud: terminalId },
    creeeLe: new Date(murale).toISOString(),
    charge: { client: { id: clientId, entrepriseId, nom, telephone: '+2250701020304' } },
  });

  it('applique une commande créée hors ligne', async () => {
    const ctx = await contexteTerminal('10');
    const commande = commandeClient(ctx.entrepriseId, ctx.terminalId, 'Aya Koné');

    const reponse = await appeler('POST', '/api/v1/sync', {
      corps: { terminalId: ctx.terminalId, commandes: [commande] },
      jeton: ctx.jeton,
    });

    expect(reponse.statut).toBe(200);
    const resultats = reponse.corps!['resultats'] as { accepte: boolean }[];
    expect(resultats[0]!.accepte).toBe(true);

    const delta = reponse.corps!['delta'] as { clients: { nom: string }[] };
    expect(delta.clients).toHaveLength(1);
    expect(delta.clients[0]!.nom).toBe('Aya Koné');
  });

  it('ne crée pas de doublon quand le même lot est rejoué', async () => {
    const ctx = await contexteTerminal('11');
    const commande = commandeClient(ctx.entrepriseId, ctx.terminalId, 'Client rejoué');

    // Trois envois du même lot : c'est ce qui arrive quand le réseau coupe
    // après le traitement serveur mais avant la réception de la réponse.
    for (let i = 0; i < 3; i++) {
      const reponse = await appeler('POST', '/api/v1/sync', {
        corps: { terminalId: ctx.terminalId, commandes: [commande] },
        jeton: ctx.jeton,
      });
      expect((reponse.corps!['resultats'] as { accepte: boolean }[])[0]!.accepte).toBe(true);
    }

    const [compte] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM clients WHERE entreprise_id = ${ctx.entrepriseId}
    `;
    expect(compte!.n, 'un lot rejoué ne doit jamais créer de doublon').toBe(1);
  });

  it('ne laisse pas une écriture ancienne écraser une plus récente', async () => {
    const ctx = await contexteTerminal('12');
    const clientId = uuidv7();
    const maintenant = Date.now();

    // La caisse A, en ligne, corrige la fiche.
    const recente = commandeClient(
      ctx.entrepriseId,
      ctx.terminalId,
      'Nom corrigé',
      maintenant,
      clientId,
    );
    // La caisse B, restée trois jours hors ligne, remonte une version ancienne.
    const ancienne = commandeClient(
      ctx.entrepriseId,
      ctx.terminalId,
      'Ancien nom',
      maintenant - 3 * 86_400_000,
      clientId,
    );

    await appeler('POST', '/api/v1/sync', {
      corps: { terminalId: ctx.terminalId, commandes: [recente] },
      jeton: ctx.jeton,
    });
    await appeler('POST', '/api/v1/sync', {
      corps: { terminalId: ctx.terminalId, commandes: [ancienne] },
      jeton: ctx.jeton,
    });

    const [client] = await admin<{ nom: string }[]>`
      SELECT nom FROM clients WHERE id = ${clientId}
    `;
    expect(client!.nom).toBe('Nom corrigé');
  });

  it('applique les commandes dans l’ordre causal, pas dans l’ordre du tableau', async () => {
    const ctx = await contexteTerminal('13');
    const clientId = uuidv7();
    const maintenant = Date.now();

    const reponse = await appeler('POST', '/api/v1/sync', {
      corps: {
        terminalId: ctx.terminalId,
        // Envoyées à l'envers : la plus récente d'abord.
        commandes: [
          commandeClient(ctx.entrepriseId, ctx.terminalId, 'Deuxième', maintenant, clientId),
          commandeClient(ctx.entrepriseId, ctx.terminalId, 'Premier', maintenant - 5000, clientId),
        ],
      },
      jeton: ctx.jeton,
    });

    expect(reponse.statut).toBe(200);
    const [client] = await admin<{ nom: string }[]>`SELECT nom FROM clients WHERE id = ${clientId}`;
    expect(client!.nom).toBe('Deuxième');
  });

  it('ne renvoie dans le delta que ce qui a changé depuis la dernière synchronisation', async () => {
    const ctx = await contexteTerminal('14');

    const premiere = await appeler('POST', '/api/v1/sync', {
      corps: {
        terminalId: ctx.terminalId,
        commandes: [commandeClient(ctx.entrepriseId, ctx.terminalId, 'Client initial')],
      },
      jeton: ctx.jeton,
    });
    const jusqua = (premiere.corps!['delta'] as { jusqua: string }).jusqua;

    const seconde = await appeler('POST', '/api/v1/sync', {
      corps: { terminalId: ctx.terminalId, commandes: [], depuis: jusqua },
      jeton: ctx.jeton,
    });

    expect((seconde.corps!['delta'] as { clients: unknown[] }).clients).toHaveLength(0);
  });
});

describe('isolation multi-tenant', () => {
  it('ne laisse pas une entreprise voir les données d’une autre', async () => {
    const a = await inscrireEtConnecter('20');
    const b = await inscrireEtConnecter('21');

    const appairageA = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId: a.pointDeVenteId, libelle: 'Caisse A' },
      jeton: a.jeton,
    });
    const terminalA = appairageA.corps!['terminalId'] as string;

    await appeler('POST', '/api/v1/sync', {
      corps: {
        terminalId: terminalA,
        commandes: [
          {
            id: uuidv7(),
            type: 'UPSERT_CLIENT',
            entrepriseId: a.entrepriseId,
            terminalId: terminalA,
            hlc: { murale: Date.now(), compteur: 0, noeud: terminalA },
            creeeLe: new Date().toISOString(),
            charge: {
              client: { id: uuidv7(), entrepriseId: a.entrepriseId, nom: 'Client confidentiel' },
            },
          },
        ],
      },
      jeton: a.jeton,
    });

    // B appaire son propre terminal et se synchronise : son delta doit être vide.
    const appairageB = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId: b.pointDeVenteId, libelle: 'Caisse B' },
      jeton: b.jeton,
    });
    const syncB = await appeler('POST', '/api/v1/sync', {
      corps: { terminalId: appairageB.corps!['terminalId'] as string, commandes: [] },
      jeton: b.jeton,
    });

    expect((syncB.corps!['delta'] as { clients: unknown[] }).clients).toHaveLength(0);
  });

  it('refuse à une entreprise d’allouer une plage sur le terminal d’une autre', async () => {
    const a = await inscrireEtConnecter('22');
    const b = await inscrireEtConnecter('23');

    const appairageA = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId: a.pointDeVenteId, libelle: 'Caisse A' },
      jeton: a.jeton,
    });
    const terminalA = appairageA.corps!['terminalId'] as string;

    // B connaît l'identifiant du terminal de A et tente de s'en servir.
    const tentative = await appeler('POST', `/api/v1/terminaux/${terminalA}/plages`, {
      jeton: b.jeton,
    });

    expect(tentative.statut).toBe(404);
  });

  it('refuse à une entreprise de créer un terminal sur le point de vente d’une autre', async () => {
    const a = await inscrireEtConnecter('24');
    const b = await inscrireEtConnecter('25');

    const tentative = await appeler('POST', '/api/v1/terminaux/appairage', {
      corps: { pointDeVenteId: a.pointDeVenteId, libelle: 'Caisse pirate' },
      jeton: b.jeton,
    });

    expect(tentative.statut).toBe(404);
  });
});
