import { describe, expect, it } from 'vitest';
import { construireContenuQR, lireContenuQR, VERSION_FORMAT_QR } from './contenu.js';

const facture = {
  numero: 'ABJ01-2026-000042',
  emiseLe: '2026-06-15T09:00:00.000Z',
  totaux: {
    totalBrutHT: 38_100,
    totalRemises: 0,
    totalHT: 38_100,
    totalTVA: 6_210,
    totalTTC: 44_310,
    ventilation: [],
  },
  hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef',
};

describe('contenu du QR', () => {
  it('marque le QR comme provisoire tant que la DGI n’a pas certifié', () => {
    const r = construireContenuQR(facture, 'CI-1234567-A');
    expect(r.provisoire).toBe(true);
    expect(r.donnees.certification).toBeUndefined();
  });

  it('cesse d’être provisoire une fois l’identifiant DGI reçu', () => {
    const r = construireContenuQR(
      { ...facture, identifiantCertificationDGI: 'DGI-2026-ABCD1234' },
      'CI-1234567-A',
    );
    expect(r.provisoire).toBe(false);
    expect(r.contenu).toContain('DGI-2026-ABCD1234');
  });

  it('commence par la version du format, pour qu’un lecteur sache quoi attendre', () => {
    expect(construireContenuQR(facture, 'CI-1234567-A').contenu.startsWith(VERSION_FORMAT_QR)).toBe(
      true,
    );
  });

  it('reste assez court pour une matrice lisible sur ticket thermique', () => {
    const r = construireContenuQR(
      { ...facture, identifiantCertificationDGI: 'DGI-2026-ABCD1234' },
      'CI-1234567-A',
    );
    // Au-delà de ~150 caractères, la matrice se densifie au point de mal se
    // lire sur une impression thermique scannée par un téléphone bas de gamme.
    expect(r.contenu.length).toBeLessThan(150);
  });

  it('fait un aller-retour sans perte', () => {
    const r = construireContenuQR(
      { ...facture, identifiantCertificationDGI: 'DGI-2026-ABCD1234' },
      'CI-1234567-A',
    );
    expect(lireContenuQR(r.contenu)).toEqual(r.donnees);
  });

  it('refuse un contenu d’un autre format', () => {
    expect(lireContenuQR('AUTRE|x|y')).toBeNull();
    expect(lireContenuQR('')).toBeNull();
  });

  it('n’expose pas l’empreinte complète', () => {
    const r = construireContenuQR(facture, 'CI-1234567-A');
    expect(r.donnees.empreinte).toHaveLength(16);
    expect(r.contenu).not.toContain(facture.hash);
  });
});
