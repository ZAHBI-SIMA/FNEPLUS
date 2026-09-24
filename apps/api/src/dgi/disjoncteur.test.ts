import { describe, expect, it } from 'vitest';
import { Disjoncteur, DisjoncteurOuvert } from './disjoncteur.js';

/** Horloge contrôlée : le disjoncteur raisonne sur le temps, pas sur des appels. */
function horloge(depart = 1_000_000) {
  let t = depart;
  return { maintenant: () => t, avancer: (ms: number) => (t += ms) };
}

describe('disjoncteur', () => {
  it('laisse passer tant que les appels réussissent', async () => {
    const d = new Disjoncteur({ seuilEchecs: 3 });
    for (let i = 0; i < 10; i++) {
      await expect(d.executer(async () => 'ok')).resolves.toBe('ok');
    }
    expect(d.etat).toBe('FERME');
  });

  it('coupe après le seuil d’échecs consécutifs', async () => {
    const d = new Disjoncteur({ seuilEchecs: 3 });

    for (let i = 0; i < 3; i++) {
      await expect(d.executer(async () => Promise.reject(new Error('panne')))).rejects.toThrow();
    }

    expect(d.etat).toBe('OUVERT');
    await expect(d.executer(async () => 'ok')).rejects.toThrow(DisjoncteurOuvert);
  });

  it('ne coupe pas sur des échecs non consécutifs', async () => {
    const d = new Disjoncteur({ seuilEchecs: 3 });

    for (let i = 0; i < 5; i++) {
      await expect(d.executer(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await d.executer(async () => 'ok');
    }

    expect(d.etat).toBe('FERME');
  });

  it('autorise un essai après la durée d’ouverture', async () => {
    const h = horloge();
    const d = new Disjoncteur({
      seuilEchecs: 2,
      dureeOuvertureMs: 30_000,
      maintenant: h.maintenant,
    });

    await expect(d.executer(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    await expect(d.executer(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(d.etat).toBe('OUVERT');

    h.avancer(29_000);
    expect(d.etat).toBe('OUVERT');

    h.avancer(2_000);
    expect(d.etat).toBe('SEMI_OUVERT');
  });

  it('se referme après assez de succès en semi-ouvert', async () => {
    const h = horloge();
    const d = new Disjoncteur({
      seuilEchecs: 1,
      dureeOuvertureMs: 1_000,
      succesPourFermer: 2,
      maintenant: h.maintenant,
    });

    await expect(d.executer(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    h.avancer(2_000);
    expect(d.etat).toBe('SEMI_OUVERT');

    await d.executer(async () => 'ok');
    expect(d.etat).toBe('SEMI_OUVERT');

    await d.executer(async () => 'ok');
    expect(d.etat).toBe('FERME');
  });

  it('rouvre immédiatement si l’essai de reprise échoue', async () => {
    const h = horloge();
    const d = new Disjoncteur({
      seuilEchecs: 5,
      dureeOuvertureMs: 1_000,
      maintenant: h.maintenant,
    });

    for (let i = 0; i < 5; i++) {
      await expect(d.executer(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    }
    h.avancer(2_000);
    expect(d.etat).toBe('SEMI_OUVERT');

    // Un seul échec suffit : inutile de recompter jusqu'au seuil, on sait déjà
    // que le service n'est pas revenu.
    await expect(d.executer(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(d.etat).toBe('OUVERT');
  });

  it('indique dans l’erreur quand réessayer', async () => {
    const h = horloge();
    const d = new Disjoncteur({
      seuilEchecs: 1,
      dureeOuvertureMs: 30_000,
      maintenant: h.maintenant,
    });
    await expect(d.executer(async () => Promise.reject(new Error('x')))).rejects.toThrow();

    await expect(d.executer(async () => 'ok')).rejects.toThrow(/30 s/);
  });
});
