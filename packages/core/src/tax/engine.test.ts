import { describe, expect, it } from 'vitest';
import { calculerFacture, ErreurCalcul, verifierTotaux } from './engine.js';
import type { VersionReferentielFiscal } from './referentiel.js';
import { REFERENTIEL_2026_01, resoudreReferentiel } from './referentiel.js';
import type { LigneFacture } from '../types.js';

const ligne = (p: Partial<LigneFacture>): LigneFacture => ({
  id: 'l1',
  designation: 'Article',
  quantite: 1,
  prixUnitaireHT: 1000,
  codeTva: 'TVA_NORMAL',
  ...p,
});

const contexteRSI = { dateEmission: '2026-06-15', regimeFiscal: 'REEL_SIMPLIFIE' as const };

describe('calculerFacture — cas nominal', () => {
  it('applique le taux normal de 18 % au régime réel', () => {
    const r = calculerFacture([ligne({ prixUnitaireHT: 10_000, quantite: 3 })], contexteRSI);

    expect(r.totaux.totalHT).toBe(30_000);
    expect(r.totaux.totalTVA).toBe(5_400);
    expect(r.totaux.totalTTC).toBe(35_400);
    expect(r.exonereParRegime).toBe(false);
    expect(r.versionReferentielFiscal).toBe('2026.01');
  });

  it('applique la remise avant la TVA', () => {
    const r = calculerFacture(
      [ligne({ prixUnitaireHT: 100_000, quantite: 1, remisePourcent: 10 })],
      contexteRSI,
    );

    expect(r.totaux.totalBrutHT).toBe(100_000);
    expect(r.totaux.totalRemises).toBe(10_000);
    expect(r.totaux.totalHT).toBe(90_000);
    expect(r.totaux.totalTVA).toBe(16_200);
  });

  it('ventile par taux et non par ligne', () => {
    const r = calculerFacture(
      [
        ligne({ id: 'a', prixUnitaireHT: 10_000, codeTva: 'TVA_NORMAL' }),
        ligne({ id: 'b', prixUnitaireHT: 20_000, codeTva: 'TVA_NORMAL' }),
        ligne({ id: 'c', prixUnitaireHT: 5_000, codeTva: 'TVA_REDUIT' }),
        ligne({ id: 'd', prixUnitaireHT: 7_000, codeTva: 'EXONERE' }),
      ],
      contexteRSI,
    );

    expect(r.totaux.ventilation).toHaveLength(3);
    const normal = r.totaux.ventilation.find((v) => v.codeTva === 'TVA_NORMAL');
    expect(normal).toMatchObject({ taux: 18, baseHT: 30_000, montantTVA: 5_400 });
    const reduit = r.totaux.ventilation.find((v) => v.codeTva === 'TVA_REDUIT');
    expect(reduit).toMatchObject({ taux: 9, baseHT: 5_000, montantTVA: 450 });
    const exo = r.totaux.ventilation.find((v) => v.codeTva === 'EXONERE');
    expect(exo).toMatchObject({ taux: 0, montantTVA: 0 });
  });
});

describe('calculerFacture — régimes non assujettis', () => {
  it.each(['ENTREPRENANT', 'MICROENTREPRISE'] as const)(
    'ne collecte aucune TVA en régime %s',
    (regimeFiscal) => {
      const r = calculerFacture([ligne({ prixUnitaireHT: 50_000 })], {
        dateEmission: '2026-06-15',
        regimeFiscal,
      });

      expect(r.totaux.totalTVA).toBe(0);
      expect(r.totaux.totalTTC).toBe(50_000);
      expect(r.exonereParRegime).toBe(true);
      expect(r.lignes[0]!.tauxTvaApplique).toBe(0);
    },
  );

  it('collecte la TVA en réel normal', () => {
    const r = calculerFacture([ligne({ prixUnitaireHT: 50_000 })], {
      dateEmission: '2026-06-15',
      regimeFiscal: 'REEL_NORMAL',
    });
    expect(r.totaux.totalTVA).toBe(9_000);
  });
});

describe('calculerFacture — arrondis en franc CFA', () => {
  it('ne produit jamais de montant décimal', () => {
    const r = calculerFacture([ligne({ prixUnitaireHT: 333, quantite: 7 })], contexteRSI);

    for (const montant of [r.totaux.totalHT, r.totaux.totalTVA, r.totaux.totalTTC]) {
      expect(Number.isInteger(montant)).toBe(true);
    }
    // 333 × 7 = 2 331 HT ; 18 % = 419,58 → 420
    expect(r.totaux.totalHT).toBe(2_331);
    expect(r.totaux.totalTVA).toBe(420);
  });

  it('garde le total ventilé cohérent malgré les arrondis ligne à ligne', () => {
    // 100 lignes à 333 F : sommer les TVA arrondies ligne à ligne donnerait 6000,
    // alors que la base agrégée (33 300) taxée à 18 % donne 5 994.
    const lignes = Array.from({ length: 100 }, (_, i) =>
      ligne({ id: `l${i}`, prixUnitaireHT: 333 }),
    );
    const r = calculerFacture(lignes, contexteRSI);

    expect(r.totaux.totalHT).toBe(33_300);
    expect(r.totaux.totalTVA).toBe(5_994);
    expect(r.totaux.totalTTC).toBe(39_294);
  });
});

describe('calculerFacture — validation des entrées', () => {
  it('refuse une facture sans ligne', () => {
    expect(() => calculerFacture([], contexteRSI)).toThrow(ErreurCalcul);
  });

  it('refuse une quantité nulle ou négative', () => {
    expect(() => calculerFacture([ligne({ quantite: 0 })], contexteRSI)).toThrow(/quantité/);
    expect(() => calculerFacture([ligne({ quantite: -2 })], contexteRSI)).toThrow(/quantité/);
  });

  it('refuse un prix unitaire décimal', () => {
    expect(() => calculerFacture([ligne({ prixUnitaireHT: 1000.5 })], contexteRSI)).toThrow(
      /entier de francs/,
    );
  });

  it('refuse une remise hors bornes', () => {
    expect(() => calculerFacture([ligne({ remisePourcent: 120 })], contexteRSI)).toThrow(/remise/);
    expect(() => calculerFacture([ligne({ remisePourcent: -5 })], contexteRSI)).toThrow(/remise/);
  });
});

describe('résolution du référentiel par date d’émission', () => {
  const v2027: VersionReferentielFiscal = {
    ...REFERENTIEL_2026_01,
    version: '2027.01',
    dateEffet: '2027-01-01',
    dateFin: null,
    tauxTVA: REFERENTIEL_2026_01.tauxTVA.map((t) =>
      t.code === 'TVA_NORMAL' ? { ...t, taux: 20 } : t,
    ),
  };
  const versions = [{ ...REFERENTIEL_2026_01, dateFin: '2026-12-31' }, v2027];

  it('utilise le taux en vigueur à la date d’émission, pas celui du jour', () => {
    const ancienne = calculerFacture([ligne({ prixUnitaireHT: 10_000 })], {
      ...contexteRSI,
      dateEmission: '2026-11-30',
      versionsReferentiel: versions,
    });
    const nouvelle = calculerFacture([ligne({ prixUnitaireHT: 10_000 })], {
      ...contexteRSI,
      dateEmission: '2027-03-01',
      versionsReferentiel: versions,
    });

    expect(ancienne.totaux.totalTVA).toBe(1_800);
    expect(ancienne.versionReferentielFiscal).toBe('2026.01');
    expect(nouvelle.totaux.totalTVA).toBe(2_000);
    expect(nouvelle.versionReferentielFiscal).toBe('2027.01');
  });

  it('échoue explicitement si aucune version ne couvre la date', () => {
    expect(() => resoudreReferentiel('2020-01-01', versions)).toThrow(/Aucun référentiel/);
  });
});

describe('verifierTotaux — contrôle serveur d’une facture émise hors ligne', () => {
  it('accepte des totaux corrects', () => {
    const lignes = [ligne({ prixUnitaireHT: 10_000, quantite: 2 })];
    const { totaux } = calculerFacture(lignes, contexteRSI);

    const v = verifierTotaux(lignes, totaux, contexteRSI);
    expect(v.conforme).toBe(true);
    expect(v.ecarts).toEqual([]);
  });

  it('détecte des totaux falsifiés par un terminal', () => {
    const lignes = [ligne({ prixUnitaireHT: 10_000, quantite: 2 })];
    const { totaux } = calculerFacture(lignes, contexteRSI);
    const falsifies = { ...totaux, totalTVA: 0, totalTTC: totaux.totalHT };

    const v = verifierTotaux(lignes, falsifies, contexteRSI);
    expect(v.conforme).toBe(false);
    expect(v.ecarts).toHaveLength(2);
    expect(v.recalcul.totaux.totalTVA).toBe(3_600);
  });
});
