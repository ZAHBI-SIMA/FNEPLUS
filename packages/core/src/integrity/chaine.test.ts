import { describe, expect, it } from 'vitest';
import { calculerHash, canoniser, HASH_GENESE, verifierChaine } from './chaine.js';
import { calculerFacture } from '../tax/engine.js';
import type { Facture, LigneFacture } from '../types.js';

const lignes: LigneFacture[] = [
  {
    id: 'l1',
    designation: 'Sac de riz 25 kg',
    quantite: 2,
    prixUnitaireHT: 15_000,
    codeTva: 'TVA_NORMAL',
  },
];

async function fabriquerFacture(numero: string, hashPrecedent: string): Promise<Facture> {
  const calcul = calculerFacture(lignes, {
    dateEmission: '2026-06-15',
    regimeFiscal: 'REEL_SIMPLIFIE',
  });

  const sansHash = {
    entrepriseId: 'ent-1',
    pointDeVenteId: 'pdv-1',
    terminalId: 'term-1',
    type: 'FACTURE' as const,
    numero,
    emiseLe: '2026-06-15T09:00:00.000Z',
    clientNom: 'Client comptant',
    lignes,
    totaux: calcul.totaux,
    versionReferentielFiscal: calcul.versionReferentielFiscal,
    hashPrecedent,
  };

  return {
    ...sansHash,
    id: `fac-${numero}`,
    statut: 'EMISE_LOCALEMENT',
    hash: await calculerHash(sansHash),
  };
}

describe('canoniser', () => {
  it('produit la même sortie quel que soit l’ordre des clés', () => {
    expect(canoniser({ b: 1, a: 2 })).toBe(canoniser({ a: 2, b: 1 }));
  });

  it('ignore les champs indéfinis', () => {
    expect(canoniser({ a: 1, b: undefined })).toBe(canoniser({ a: 1 }));
  });

  it('préserve l’ordre des tableaux, qui est significatif', () => {
    expect(canoniser([1, 2])).not.toBe(canoniser([2, 1]));
  });
});

describe('chaîne d’intégrité', () => {
  it('valide une chaîne intacte', async () => {
    const f1 = await fabriquerFacture('ABJ01-000001', HASH_GENESE);
    const f2 = await fabriquerFacture('ABJ01-000002', f1.hash);
    const f3 = await fabriquerFacture('ABJ01-000003', f2.hash);

    const r = await verifierChaine([f1, f2, f3]);
    expect(r.valide).toBe(true);
    expect(r.anomalies).toEqual([]);
  });

  it('détecte la modification d’un montant après émission', async () => {
    const f1 = await fabriquerFacture('ABJ01-000001', HASH_GENESE);
    const f2 = await fabriquerFacture('ABJ01-000002', f1.hash);

    const falsifiee: Facture = {
      ...f2,
      totaux: { ...f2.totaux, totalTTC: 1 },
    };

    const r = await verifierChaine([f1, falsifiee]);
    expect(r.valide).toBe(false);
    expect(r.anomalies[0]!.type).toBe('HASH_INVALIDE');
  });

  it('détecte la suppression d’une facture au milieu de la chaîne', async () => {
    const f1 = await fabriquerFacture('ABJ01-000001', HASH_GENESE);
    const f2 = await fabriquerFacture('ABJ01-000002', f1.hash);
    const f3 = await fabriquerFacture('ABJ01-000003', f2.hash);

    const r = await verifierChaine([f1, f3]);
    expect(r.valide).toBe(false);
    expect(r.anomalies.some((a) => a.type === 'CHAINAGE_ROMPU')).toBe(true);
    expect(r.anomalies[0]!.numero).toBe('ABJ01-000003');
  });

  it('reste stable quand le statut de transmission évolue', async () => {
    const f1 = await fabriquerFacture('ABJ01-000001', HASH_GENESE);
    const apresCertification: Facture = {
      ...f1,
      statut: 'CERTIFIEE',
      identifiantCertificationDGI: 'DGI-XYZ-123',
      horodatageCertifie: '2026-06-15T09:02:11.000Z',
    };

    expect(await calculerHash(apresCertification)).toBe(f1.hash);
  });
});
