import { describe, expect, it } from 'vitest';
import {
  cloturerPlage,
  consommerNumero,
  ErreurPlage,
  formaterNumero,
  numerosRestants,
  PlageEpuisee,
  plageBientotEpuisee,
  verifierContinuite,
  type PlageNumeros,
} from './plage.js';

const plageTest = (p: Partial<PlageNumeros> = {}): PlageNumeros => ({
  id: 'plage-1',
  entrepriseId: 'ent-1',
  pointDeVenteId: 'pdv-1',
  terminalId: 'term-1',
  prefixe: 'ABJ01-2026',
  debut: 1,
  fin: 100,
  curseur: 1,
  longueurCompteur: 6,
  allouceLe: '2026-06-01T08:00:00.000Z',
  ...p,
});

describe('consommation de numéros', () => {
  it('formate le numéro avec préfixe et compteur à longueur fixe', () => {
    const { numero } = consommerNumero(plageTest());
    expect(numero).toBe('ABJ01-2026-000001');
  });

  it('avance le curseur sans muter la plage d’origine', () => {
    const plage = plageTest();
    const r = consommerNumero(plage);

    expect(r.plage.curseur).toBe(2);
    expect(plage.curseur).toBe(1);
  });

  it('produit une séquence continue sur toute la plage', () => {
    let plage = plageTest({ debut: 1, fin: 50 });
    const compteurs: number[] = [];

    for (let i = 0; i < 50; i++) {
      const r = consommerNumero(plage);
      compteurs.push(r.compteur);
      plage = r.plage;
    }

    expect(verifierContinuite(compteurs).continue).toBe(true);
    expect(compteurs[0]).toBe(1);
    expect(compteurs.at(-1)).toBe(50);
    expect(numerosRestants(plage)).toBe(0);
  });

  it('refuse de servir au-delà de la borne haute', () => {
    const plage = plageTest({ debut: 1, fin: 1, curseur: 2 });
    expect(() => consommerNumero(plage)).toThrow(PlageEpuisee);
    expect(() => consommerNumero(plage)).toThrow(/recharger/);
  });

  it('refuse de servir depuis une plage clôturée', () => {
    const plage = plageTest({ clotureeLe: '2026-06-02T10:00:00.000Z' });
    expect(() => consommerNumero(plage)).toThrow(ErreurPlage);
  });
});

describe('deux terminaux hors ligne ne collisionnent jamais', () => {
  it('produit des numéros disjoints sur des plages disjointes', () => {
    let caisse1 = plageTest({ terminalId: 'term-1', debut: 1, fin: 500, curseur: 1 });
    let caisse2 = plageTest({ terminalId: 'term-2', debut: 501, fin: 1000, curseur: 501 });

    const numeros = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const a = consommerNumero(caisse1);
      const b = consommerNumero(caisse2);
      numeros.add(a.numero);
      numeros.add(b.numero);
      caisse1 = a.plage;
      caisse2 = b.plage;
    }

    expect(numeros.size).toBe(1000);
  });
});

describe('alerte de fin de plage', () => {
  it('n’alerte pas tant qu’il reste plus de 20 % de la réserve', () => {
    expect(plageBientotEpuisee(plageTest({ debut: 1, fin: 100, curseur: 50 }))).toBe(false);
  });

  it('alerte sous le seuil de 20 %', () => {
    expect(plageBientotEpuisee(plageTest({ debut: 1, fin: 100, curseur: 81 }))).toBe(true);
  });

  it('considère une plage clôturée comme épuisée', () => {
    const plage = plageTest({ curseur: 10, clotureeLe: '2026-06-02T10:00:00.000Z' });
    expect(numerosRestants(plage)).toBe(0);
    expect(plageBientotEpuisee(plage)).toBe(true);
  });
});

describe('clôture anticipée', () => {
  it('déclare les numéros non consommés au lieu de les laisser en trou inexpliqué', () => {
    const plage = plageTest({ debut: 1, fin: 100, curseur: 31 });
    const r = cloturerPlage(plage, '2026-06-02T10:00:00.000Z');

    expect(r.numerosNonUtilises).toBe(70);
    expect(r.plage.clotureeLe).toBe('2026-06-02T10:00:00.000Z');
  });

  it('est idempotente', () => {
    const plage = plageTest({ clotureeLe: '2026-06-02T10:00:00.000Z' });
    expect(cloturerPlage(plage, '2026-06-03T10:00:00.000Z').numerosNonUtilises).toBe(0);
  });
});

describe('verifierContinuite — contrôle de séquence', () => {
  it('valide une séquence complète', () => {
    expect(verifierContinuite([1, 2, 3, 4, 5]).continue).toBe(true);
  });

  it('détecte un trou', () => {
    const r = verifierContinuite([1, 2, 5]);
    expect(r.continue).toBe(false);
    expect(r.trous).toEqual([3, 4]);
  });

  it('détecte un doublon', () => {
    const r = verifierContinuite([1, 2, 2, 3]);
    expect(r.continue).toBe(false);
    expect(r.doublons).toEqual([2]);
  });

  it('ignore l’ordre d’arrivée des numéros', () => {
    expect(verifierContinuite([3, 1, 2]).continue).toBe(true);
  });
});

describe('formaterNumero', () => {
  it('respecte la longueur de compteur configurée', () => {
    expect(formaterNumero(plageTest({ longueurCompteur: 4 }), 42)).toBe('ABJ01-2026-0042');
  });
});
