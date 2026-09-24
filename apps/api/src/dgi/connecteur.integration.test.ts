/**
 * Tests d'intégration du connecteur DGI et de l'archivage.
 *
 * Ils tournent contre un vrai PostgreSQL et un vrai simulateur DGI, dont le
 * panneau de contrôle permet d'injecter latence, erreurs et coupures.
 *
 * Critère d'acceptation du Sprint 4 : API DGI coupée, aucune facture perdue ;
 * rejeu automatique complet au rétablissement ; export de contrôle vérifiable
 * de bout en bout.
 *
 * Prérequis : `pnpm infra:up`, `pnpm --filter @fneplus/api migrer`.
 */

import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres from 'postgres';
import { calculerFacture, calculerHash, HASH_GENESE, uuidv7, type Facture } from '@fneplus/core';
import { AppModule } from '../app.module.js';
import { SmsService } from '../auth/sms.service.js';
import { TransmissionService } from './transmission.service.js';
import { ArchivageService } from '../archivage/archivage.service.js';

const URL_ADMIN =
  process.env['DATABASE_URL_ADMIN'] ?? 'postgres://fneplus:fneplus_dev@localhost:5435/fneplus';
const URL_SIM = process.env['DGI_URL'] ?? 'http://localhost:4010';

let app: NestFastifyApplication;
let admin: postgres.Sql;
let transmission: TransmissionService;
let archivage: ArchivageService;
let sms: SmsService;

/** Pilote le simulateur : latence, taux d'erreur, coupure totale. */
async function configurerSimulateur(config: Record<string, unknown>): Promise<void> {
  await fetch(`${URL_SIM}/_simulateur/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

async function reinitialiserSimulateur(): Promise<void> {
  await fetch(`${URL_SIM}/_simulateur/reinitialiser`, { method: 'POST' });
  await configurerSimulateur({ latenceMs: 0, tauxErreur: 0, tauxRejet: 0, panne: false });
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

/** Inscrit une entreprise, ouvre une session, appaire un terminal. */
async function preparerTerminal(suffixe: string) {
  const telephone = `+2250790000${suffixe.padStart(3, '0')}`;

  const inscription = await appeler('POST', '/api/v1/entreprises/inscription', {
    corps: {
      ncc: `CI-DGI-${suffixe}`,
      raisonSociale: `Boutique DGI ${suffixe}`,
      regimeFiscal: 'REEL_SIMPLIFIE',
      telephone,
      nomProprietaire: 'Responsable',
    },
  });
  expect(inscription.statut).toBe(201);

  await appeler('POST', '/api/v1/auth/demander-code', { corps: { telephone } });
  const code = sms.envoyes.at(-1)?.contenu.match(/\b(\d{6})\b/)?.[1];
  const connexion = await appeler('POST', '/api/v1/auth/verifier-code', {
    corps: { telephone, code },
  });

  const jeton = connexion.corps!['jeton'] as string;
  const appairage = await appeler('POST', '/api/v1/terminaux/appairage', {
    corps: { pointDeVenteId: inscription.corps!['pointDeVenteId'], libelle: 'Caisse' },
    jeton,
  });

  return {
    jeton,
    entrepriseId: inscription.corps!['entrepriseId'] as string,
    pointDeVenteId: inscription.corps!['pointDeVenteId'] as string,
    terminalId: appairage.corps!['terminalId'] as string,
    ncc: `CI-DGI-${suffixe}`,
  };
}

/** Construit une facture chaînée, comme le ferait un terminal. */
async function fabriquerFacture(
  ctx: { entrepriseId: string; pointDeVenteId: string; terminalId: string },
  numero: number,
  hashPrecedent: string,
): Promise<Facture> {
  const lignes = [
    {
      id: uuidv7(),
      designation: 'Sac de riz 25 kg',
      quantite: 1,
      prixUnitaireHT: 18_500,
      codeTva: 'TVA_NORMAL' as const,
    },
  ];
  const emiseLe = new Date(Date.UTC(2026, 5, 15, 9, 0, numero)).toISOString();
  const calcul = calculerFacture(lignes, { dateEmission: emiseLe, regimeFiscal: 'REEL_SIMPLIFIE' });

  const sansHash = {
    entrepriseId: ctx.entrepriseId,
    pointDeVenteId: ctx.pointDeVenteId,
    terminalId: ctx.terminalId,
    type: 'FACTURE' as const,
    numero: `PDV01-2026-${String(numero).padStart(6, '0')}`,
    emiseLe,
    clientNom: 'Client comptant',
    lignes,
    totaux: calcul.totaux,
    versionReferentielFiscal: calcul.versionReferentielFiscal,
    hashPrecedent,
  };

  return {
    ...sansHash,
    id: uuidv7(),
    statut: 'EMISE_LOCALEMENT',
    hash: await calculerHash(sansHash),
  };
}

/** Pousse N factures chaînées par la route de synchronisation. */
async function pousserFactures(
  ctx: Awaited<ReturnType<typeof preparerTerminal>>,
  nombre: number,
): Promise<Facture[]> {
  const factures: Facture[] = [];
  let precedent = HASH_GENESE;

  for (let i = 1; i <= nombre; i++) {
    const facture = await fabriquerFacture(ctx, i, precedent);
    precedent = facture.hash;
    factures.push(facture);
  }

  const reponse = await appeler('POST', '/api/v1/sync', {
    corps: {
      terminalId: ctx.terminalId,
      commandes: factures.map((facture, index) => ({
        id: uuidv7(),
        type: 'CREER_FACTURE',
        entrepriseId: ctx.entrepriseId,
        terminalId: ctx.terminalId,
        hlc: { murale: Date.now() + index, compteur: 0, noeud: ctx.terminalId },
        creeeLe: facture.emiseLe,
        charge: { facture, lignes: facture.lignes },
      })),
    },
    jeton: ctx.jeton,
  });

  const resultats = reponse.corps!['resultats'] as { accepte: boolean }[];
  expect(resultats.every((r) => r.accepte)).toBe(true);
  return factures;
}

beforeAll(async () => {
  admin = postgres(URL_ADMIN, { max: 2, onnotice: () => {} });

  // L'ordonnanceur périodique est désactivé : les tests déclenchent les cycles
  // eux-mêmes, sinon un cycle de fond fausserait les comptages.
  process.env['FNE_SANS_ORDONNANCEUR'] = '1';

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  transmission = app.get(TransmissionService);
  archivage = app.get(ArchivageService);
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

describe('transmission nominale', () => {
  it('certifie les factures reçues et les sort de la file', async () => {
    const ctx = await preparerTerminal('1');
    await pousserFactures(ctx, 3);

    const avant = await transmission.etatFile();
    expect(avant['EN_ATTENTE']).toBe(3);

    const cycle = await transmission.traiterLot();
    expect(cycle.certifiees).toBe(3);
    expect(cycle.reportees).toBe(0);

    const apres = await transmission.etatFile();
    expect(apres['EN_ATTENTE']).toBeUndefined();
    expect(apres['CERTIFIEE']).toBe(3);

    const factures = await admin<{ statut: string; identifiant_dgi: string | null }[]>`
      SELECT statut, identifiant_dgi FROM factures ORDER BY numero
    `;
    expect(factures.every((f) => f.statut === 'CERTIFIEE')).toBe(true);
    expect(factures.every((f) => f.identifiant_dgi !== null)).toBe(true);
  }, 60_000);

  it('ne transmet pas deux fois la même facture', async () => {
    const ctx = await preparerTerminal('2');
    await pousserFactures(ctx, 2);

    await transmission.traiterLot();
    const second = await transmission.traiterLot();

    // Rien à refaire : les factures ne sont plus en attente.
    expect(second.traitees).toBe(0);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe('API DGI indisponible — critère d’acceptation', () => {
  it('ne perd aucune facture pendant une coupure, et rejoue tout au rétablissement', async () => {
    const ctx = await preparerTerminal('3');
    await pousserFactures(ctx, 10);

    // Coupure totale de la DGI : la connexion est fermée sans réponse.
    await configurerSimulateur({ panne: true });

    const pendantPanne = await transmission.traiterLot();
    expect(pendantPanne.certifiees).toBe(0);
    expect(pendantPanne.reportees).toBeGreaterThan(0);

    // Rien n'est perdu : tout est encore en file.
    const fileEnPanne = await transmission.etatFile();
    expect(fileEnPanne['EN_ATTENTE']).toBe(10);
    expect(fileEnPanne['CERTIFIEE']).toBeUndefined();

    // Le disjoncteur a coupé pour ne pas marteler le service.
    expect(transmission.etatDisjoncteur).toBe('OUVERT');

    // Rétablissement. On remet les factures dues immédiatement, comme le ferait
    // le repli exponentiel après le temps d'attente.
    await configurerSimulateur({ panne: false });
    await admin`UPDATE file_transmission SET prochaine_tentative_le = now() WHERE etat = 'EN_ATTENTE'`;
    transmission['disjoncteur'].reinitialiser();

    const apresReprise = await transmission.traiterLot(50);
    expect(apresReprise.certifiees).toBe(10);

    const fileFinale = await transmission.etatFile();
    expect(fileFinale['CERTIFIEE']).toBe(10);
    expect(fileFinale['EN_ATTENTE']).toBeUndefined();
  }, 120_000);

  it('reporte sans perdre quand la DGI répond en erreur serveur', async () => {
    const ctx = await preparerTerminal('4');
    await pousserFactures(ctx, 5);

    await configurerSimulateur({ tauxErreur: 1 });
    const cycle = await transmission.traiterLot();

    expect(cycle.certifiees).toBe(0);
    expect((await transmission.etatFile())['EN_ATTENTE']).toBe(5);

    await configurerSimulateur({ tauxErreur: 0 });
    await admin`UPDATE file_transmission SET prochaine_tentative_le = now()`;
    transmission['disjoncteur'].reinitialiser();

    const reprise = await transmission.traiterLot(50);
    expect(reprise.certifiees).toBe(5);
  }, 120_000);

  it('encaisse une latence importante sans abandonner', async () => {
    const ctx = await preparerTerminal('5');
    await pousserFactures(ctx, 2);

    await configurerSimulateur({ latenceMs: 1_500 });
    const cycle = await transmission.traiterLot();

    expect(cycle.certifiees).toBe(2);
  }, 120_000);

  it('classe un rejet métier comme définitif, sans ouvrir le disjoncteur', async () => {
    const ctx = await preparerTerminal('6');
    await pousserFactures(ctx, 3);

    // Le simulateur refuse : le service fonctionne parfaitement, ce sont les
    // factures qui sont refusées. Le disjoncteur ne doit pas s'en mêler.
    await configurerSimulateur({ tauxRejet: 1 });
    const cycle = await transmission.traiterLot();

    expect(cycle.rejetees).toBe(3);
    expect(transmission.etatDisjoncteur).toBe('FERME');

    const factures = await admin<{ statut: string; motif_rejet: string }[]>`
      SELECT statut, motif_rejet FROM factures
    `;
    expect(factures.every((f) => f.statut === 'REJETEE')).toBe(true);
    expect(factures.every((f) => (f.motif_rejet ?? '').length > 0)).toBe(true);
  }, 120_000);
});

/* ------------------------------------------------------------------ */

describe('archivage et export de contrôle', () => {
  it('vérifie une chaîne intacte', async () => {
    const ctx = await preparerTerminal('10');
    await pousserFactures(ctx, 5);

    const verification = await archivage.verifier(ctx.entrepriseId);
    expect(verification.valide).toBe(true);
    expect(verification.nombreFactures).toBe(5);
    expect(verification.anomalies).toEqual([]);
  }, 60_000);

  it('détecte une facture modifiée après archivage', async () => {
    const ctx = await preparerTerminal('11');
    await pousserFactures(ctx, 5);

    // Falsification directe en base, avec le rôle propriétaire.
    await admin`UPDATE factures SET total_ttc = 1 WHERE numero = 'PDV01-2026-000003'`;
    await admin`
      UPDATE factures
         SET totaux = jsonb_set(totaux, '{totalTTC}', '1')
       WHERE numero = 'PDV01-2026-000003'
    `;

    const verification = await archivage.verifier(ctx.entrepriseId);
    expect(verification.valide).toBe(false);
    expect(verification.anomalies.some((a) => a.numero === 'PDV01-2026-000003')).toBe(true);
  }, 60_000);

  it('détecte une facture supprimée au milieu de la chaîne', async () => {
    const ctx = await preparerTerminal('12');
    await pousserFactures(ctx, 5);

    await admin`DELETE FROM factures WHERE numero = 'PDV01-2026-000003'`;

    const verification = await archivage.verifier(ctx.entrepriseId);
    expect(verification.valide).toBe(false);
    expect(verification.anomalies.some((a) => a.type === 'CHAINAGE_ROMPU')).toBe(true);
  }, 60_000);

  it('refuse de sceller une chaîne rompue', async () => {
    const ctx = await preparerTerminal('13');
    await pousserFactures(ctx, 4);
    await admin`DELETE FROM factures WHERE numero = 'PDV01-2026-000002'`;

    const scelle = await archivage.sceller(ctx.entrepriseId, {
      debut: '2026-01-01',
      fin: '2026-12-31',
    });

    expect('refus' in scelle).toBe(true);
  }, 60_000);

  it('scelle une période valide, sans prétendre à un horodatage qualifié', async () => {
    const ctx = await preparerTerminal('14');
    await pousserFactures(ctx, 4);

    const scelle = await archivage.sceller(ctx.entrepriseId, {
      debut: '2026-01-01',
      fin: '2026-12-31',
    });

    expect('refus' in scelle).toBe(false);
    if ('refus' in scelle) return;

    expect(scelle.nombreFactures).toBe(4);
    expect(scelle.premiereFacture).toBe('PDV01-2026-000001');
    expect(scelle.derniereFacture).toBe('PDV01-2026-000004');
    // Tant qu'aucune autorité d'horodatage n'est contractée, le scellé prouve
    // l'intégrité, pas la date. L'application ne doit pas prétendre l'inverse.
    expect(scelle.horodatageQualifie).toBe(false);
  }, 60_000);

  it('produit un export de contrôle vérifiable de bout en bout', async () => {
    const ctx = await preparerTerminal('15');
    await pousserFactures(ctx, 5);
    await transmission.traiterLot();

    const exp = await archivage.exporter(
      ctx.entrepriseId,
      { debut: '2026-01-01', fin: '2026-12-31' },
      { motif: 'Contrôle fiscal' },
    );

    expect(exp.chaineValide).toBe(true);
    expect(exp.nombreFactures).toBe(5);
    expect(exp.entreprise.ncc).toBe(ctx.ncc);
    expect(exp.totaux.totalHT).toBe(5 * 18_500);
    expect(exp.commentVerifier.length).toBeGreaterThan(0);

    // Un agent doit pouvoir rejouer la chaîne à partir du seul export.
    const factures = exp.factures as { empreinte: string; empreintePrecedente: string }[];
    expect(factures[0]!.empreintePrecedente).toBe(HASH_GENESE);
    for (let i = 1; i < factures.length; i++) {
      expect(factures[i]!.empreintePrecedente).toBe(factures[i - 1]!.empreinte);
    }

    // Chaque facture porte son identifiant de certification DGI.
    expect(
      (exp.factures as { identifiantCertificationDGI: string | null }[]).every(
        (f) => f.identifiantCertificationDGI !== null,
      ),
    ).toBe(true);
  }, 60_000);

  it('trace l’export et signale une chaîne invalide plutôt que de la taire', async () => {
    const ctx = await preparerTerminal('16');
    await pousserFactures(ctx, 3);
    await admin`DELETE FROM factures WHERE numero = 'PDV01-2026-000002'`;

    const exp = await archivage.exporter(ctx.entrepriseId, {
      debut: '2026-01-01',
      fin: '2026-12-31',
    });

    expect(exp.chaineValide).toBe(false);
    expect(exp.anomalies.length).toBeGreaterThan(0);

    const [trace] = await admin<{ chaine_valide: boolean; nombre_factures: number }[]>`
      SELECT chaine_valide, nombre_factures FROM exports_controle
    `;
    expect(trace!.chaine_valide).toBe(false);
  }, 60_000);
});
