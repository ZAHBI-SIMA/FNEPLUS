import { describe, expect, it } from 'vitest';
import { depuisReponseDGI, versFactureDGI, VERSION_MAPPING } from './anticorruption.js';
import type { Facture, LigneFacture } from '@fneplus/core';

const LIGNES: LigneFacture[] = [
  {
    id: 'l1',
    designation: 'Riz 25 kg',
    quantite: 2,
    prixUnitaireHT: 18_500,
    codeTva: 'TVA_NORMAL',
  },
  {
    id: 'l2',
    designation: 'Lait 400 g',
    quantite: 3,
    prixUnitaireHT: 2_400,
    codeTva: 'TVA_REDUIT',
  },
];

const FACTURE: Facture = {
  id: '01900000-0000-7000-8000-000000000009',
  entrepriseId: 'ent-1',
  pointDeVenteId: 'pdv-1',
  terminalId: 'term-1',
  type: 'FACTURE',
  statut: 'EN_FILE_DGI',
  numero: 'PDV01-2026-000001',
  emiseLe: '2026-06-15T09:00:00.000Z',
  clientNom: 'Client comptant',
  lignes: LIGNES,
  totaux: {
    totalBrutHT: 44_200,
    totalRemises: 0,
    totalHT: 44_200,
    totalTVA: 7_308,
    totalTTC: 51_508,
    ventilation: [
      { codeTva: 'TVA_NORMAL', taux: 18, baseHT: 37_000, montantTVA: 6_660 },
      { codeTva: 'TVA_REDUIT', taux: 9, baseHT: 7_200, montantTVA: 648 },
    ],
  },
  versionReferentielFiscal: '2026.01',
  hashPrecedent: '0'.repeat(64),
  hash: 'abc123',
};

const taux = (code: string) => (code === 'TVA_NORMAL' ? 18 : code === 'TVA_REDUIT' ? 9 : 0);

describe('traduction sortante', () => {
  it('transporte l’essentiel de la facture et trace la version de mapping', () => {
    const dgi = versFactureDGI(FACTURE, LIGNES, 'CI-1234567-A', taux);

    expect(dgi.ncc).toBe('CI-1234567-A');
    expect(dgi.numero).toBe('PDV01-2026-000001');
    expect(dgi.versionMapping).toBe(VERSION_MAPPING);
    expect(dgi.empreinte).toBe('abc123');
    expect(dgi.empreintePrecedente).toBe('0'.repeat(64));
  });

  it('calcule les montants par ligne pour la DGI', () => {
    const dgi = versFactureDGI(FACTURE, LIGNES, 'CI-1234567-A', taux);

    expect(dgi.lignes[0]).toMatchObject({ montantHT: 37_000, montantTVA: 6_660, tauxTVA: 18 });
    expect(dgi.lignes[1]).toMatchObject({ montantHT: 7_200, montantTVA: 648, tauxTVA: 9 });
  });

  it('applique la remise avant la taxation', () => {
    const avecRemise: LigneFacture[] = [
      { ...LIGNES[0]!, quantite: 1, prixUnitaireHT: 100_000, remisePourcent: 10 },
    ];
    const dgi = versFactureDGI(FACTURE, avecRemise, 'CI-1234567-A', taux);

    expect(dgi.lignes[0]!.montantHT).toBe(90_000);
    expect(dgi.lignes[0]!.montantTVA).toBe(16_200);
  });

  it('n’expose pas le NCC du client quand il est absent', () => {
    const dgi = versFactureDGI(FACTURE, LIGNES, 'CI-1234567-A', taux);
    expect(dgi.client.ncc).toBeUndefined();
  });
});

describe('traduction entrante', () => {
  it('reconnaît une certification', () => {
    const r = depuisReponseDGI({
      statut: 'CERTIFIEE',
      identifiantCertification: 'DGI-2026-ABCD',
      horodatageCertifie: '2026-06-15T09:00:02.000Z',
      contenuQR: 'FNE1|...',
    });

    expect(r.certifiee).toBe(true);
    expect(r.identifiantCertification).toBe('DGI-2026-ABCD');
    expect(r.contenuQR).toBe('FNE1|...');
  });

  it('traduit un doublon de numéro en message actionnable, et le classe définitif', () => {
    const r = depuisReponseDGI({
      statut: 'REJETEE',
      motifs: ['Le numéro PDV01-2026-000001 a déjà été transmis.'],
    });

    expect(r.certifiee).toBe(false);
    expect(r.definitif).toBe(true);
    expect(r.messageUtilisateur).toMatch(/réserve de numéros/i);
  });

  it('classe une indisponibilité comme réessayable', () => {
    const r = depuisReponseDGI({
      statut: 'REJETEE',
      motifs: ['Service temporairement indisponible pour maintenance.'],
    });

    expect(r.definitif).toBe(false);
    expect(r.messageUtilisateur).toMatch(/repris/i);
  });

  it('transmet tel quel un motif non reconnu plutôt que de le masquer', () => {
    const r = depuisReponseDGI({
      statut: 'REJETEE',
      motifs: ['ERR_XY_4412 : contrainte métier non satisfaite'],
    });

    // Un message brut exploitable par le support vaut mieux qu'un « erreur
    // inconnue » qui perdrait l'information.
    expect(r.messageUtilisateur).toContain('ERR_XY_4412');
    expect(r.definitif).toBe(true);
  });

  it('gère un rejet sans motif', () => {
    const r = depuisReponseDGI({ statut: 'REJETEE' });
    expect(r.messageUtilisateur).toMatch(/sans préciser de motif/i);
  });
});
