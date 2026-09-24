import { describe, expect, it } from 'vitest';
import { comparerHLC, deserialiserHLC, HorlogeHLC, serialiserHLC } from './hlc.js';

/** Horloge contrôlée, pour simuler une horloge de smartphone qui dérive ou recule. */
function horlogeFactice(depart: number) {
  let t = depart;
  return {
    maintenant: () => t,
    avancer: (ms: number) => {
      t += ms;
    },
    reculer: (ms: number) => {
      t -= ms;
    },
  };
}

describe('HorlogeHLC', () => {
  it('reste strictement croissante quand le temps avance', () => {
    const f = horlogeFactice(1_000_000);
    const h = new HorlogeHLC('term-1', f.maintenant);

    const a = h.tick();
    f.avancer(10);
    const b = h.tick();

    expect(comparerHLC(a, b)).toBeLessThan(0);
  });

  it('reste strictement croissante quand l’horloge du téléphone recule', () => {
    const f = horlogeFactice(1_000_000);
    const h = new HorlogeHLC('term-1', f.maintenant);

    const a = h.tick();
    f.reculer(60_000); // l'utilisateur règle l'heure à la main
    const b = h.tick();
    const c = h.tick();

    expect(comparerHLC(a, b)).toBeLessThan(0);
    expect(comparerHLC(b, c)).toBeLessThan(0);
  });

  it('incrémente le compteur logique quand plusieurs événements partagent la même milliseconde', () => {
    const f = horlogeFactice(1_000_000);
    const h = new HorlogeHLC('term-1', f.maintenant);

    const a = h.tick();
    const b = h.tick();

    expect(b.murale).toBe(a.murale);
    expect(b.compteur).toBe(a.compteur + 1);
  });

  it('départage deux terminaux par identifiant à horodatage identique', () => {
    const a = { murale: 1_000, compteur: 0, noeud: 'term-a' };
    const b = { murale: 1_000, compteur: 0, noeud: 'term-b' };
    expect(comparerHLC(a, b)).toBeLessThan(0);
  });

  it('avance au-delà d’un horodatage distant observé', () => {
    const f = horlogeFactice(1_000_000);
    const h = new HorlogeHLC('term-1', f.maintenant);

    const local = h.tick();
    const distant = { murale: 2_000_000, compteur: 3, noeud: 'term-2' };
    const apres = h.observer(distant);

    expect(comparerHLC(local, apres)).toBeLessThan(0);
    expect(comparerHLC(distant, apres)).toBeLessThan(0);
  });

  it('signale une dérive excessive avec l’heure serveur', () => {
    const f = horlogeFactice(1_000_000);
    const h = new HorlogeHLC('term-1', f.maintenant);

    expect(h.recaler(1_000_500).deriveExcessive).toBe(false);
    expect(h.recaler(1_000_000 + 10 * 60 * 1000).deriveExcessive).toBe(true);
  });

  it('applique la dérive recalée aux horodatages suivants sans toucher l’horloge système', () => {
    const f = horlogeFactice(1_000_000);
    const h = new HorlogeHLC('term-1', f.maintenant);

    h.recaler(1_030_000); // le téléphone retarde de 30 s
    f.avancer(1);
    expect(h.tick().murale).toBe(1_030_001);
    expect(f.maintenant()).toBe(1_000_001);
  });
});

describe('sérialisation HLC', () => {
  it('fait un aller-retour sans perte', () => {
    const h = { murale: 1_764_500_000_000, compteur: 7, noeud: 'term-abidjan-01' };
    expect(deserialiserHLC(serialiserHLC(h))).toEqual(h);
  });

  it('produit un ordre lexicographique cohérent avec l’ordre chronologique', () => {
    const a = serialiserHLC({ murale: 1_000, compteur: 0, noeud: 'n1' });
    const b = serialiserHLC({ murale: 2_000, compteur: 0, noeud: 'n1' });
    expect(a < b).toBe(true);
  });
});
