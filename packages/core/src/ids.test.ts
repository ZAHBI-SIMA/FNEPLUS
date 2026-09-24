import { describe, expect, it } from 'vitest';
import { instantUuidv7, uuidv7 } from './ids.js';

describe('uuidv7', () => {
  it('produit un identifiant au format UUID version 7', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encode l’instant de création', () => {
    const t = 1_764_500_000_000;
    expect(instantUuidv7(uuidv7(t))).toBe(t);
  });

  it('reste trié chronologiquement en ordre lexicographique', () => {
    const a = uuidv7(1_000_000_000_000);
    const b = uuidv7(1_000_000_001_000);
    expect(a < b).toBe(true);
  });

  it('ne collisionne pas sur un gros volume généré dans la même milliseconde', () => {
    const t = Date.now();
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(t)));
    expect(ids.size).toBe(10_000);
  });
});
