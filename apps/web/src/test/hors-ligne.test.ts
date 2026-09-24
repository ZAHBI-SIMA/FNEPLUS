/**
 * Campagne de test adverse du mode hors-ligne.
 *
 * Ces tests exécutent les modules de production du terminal contre une vraie
 * base SQLite, et simulent ce qui arrive réellement sur un réseau mobile
 * ivoirien : coupure en plein envoi, serveur qui répond 503, latence de
 * plusieurs secondes, appareil éteint pendant une synchronisation, horloge
 * déréglée.
 *
 * Critère d'acceptation du Sprint 3 : 500 factures émises hors ligne se
 * synchronisent sans perte, sans doublon et sans trou de séquence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HorlogeHLC,
  numerosRestants,
  verifierChaine,
  verifierContinuite,
  type Facture,
  type LigneFacture,
  type ResultatCommande,
} from '@fneplus/core';
import {
  amorcerTerminal,
  DepotNode,
  ENTREPRISE_TEST,
  NCC_TEST,
  PDV_TEST,
  TERMINAL_TEST,
} from './depot-node';
import { emettreFacture, plageActive } from '../lib/depot/factures';
import {
  appliquerResultats,
  compterEchecsDefinitifs,
  compterEnAttente,
  marquerEnCours,
  prochainLot,
  recupererCommandesInterrompues,
  relancerImmediatement,
} from '../lib/outbox';
import {
  etatStockage,
  listerAnomalies,
  purgerStockage,
  reessayerCommande,
} from '../lib/depot/a-verifier';

const LIGNES: Omit<LigneFacture, 'id'>[] = [
  { designation: 'Sac de riz 25 kg', quantite: 1, prixUnitaireHT: 18_500, codeTva: 'TVA_NORMAL' },
  { designation: 'Lait 400 g', quantite: 3, prixUnitaireHT: 2_400, codeTva: 'TVA_REDUIT' },
];

let base: DepotNode;
let horloge: HorlogeHLC;

const contexte = () => ({
  entrepriseId: ENTREPRISE_TEST,
  ncc: NCC_TEST,
  pointDeVenteId: PDV_TEST,
  terminalId: TERMINAL_TEST,
  regimeFiscal: 'REEL_SIMPLIFIE' as const,
  hlc: horloge.tick(),
});

async function emettre(n = 1): Promise<Facture[]> {
  const factures: Facture[] = [];
  for (let i = 0; i < n; i++) {
    factures.push(
      await emettreFacture(base, contexte(), { clientNom: `Client ${i}`, lignes: LIGNES }),
    );
  }
  return factures;
}

beforeEach(() => {
  base = new DepotNode();
  amorcerTerminal(base, { taillePlage: 1000 });
  horloge = new HorlogeHLC(TERMINAL_TEST);
});

afterEach(() => {
  base.fermer();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */

describe('émission hors ligne', () => {
  it('émet une facture complète sans aucun accès réseau', async () => {
    const [facture] = await emettre(1);

    expect(facture!.numero).toBe('PDV01-2026-000001');
    expect(facture!.statut).toBe('EMISE_LOCALEMENT');
    expect(facture!.totaux.totalHT).toBe(25_700);
    expect(facture!.totaux.totalTVA).toBe(3_978);
    expect(facture!.contenuQR).toContain('FNE1|');
    expect(compterEnAttente(base)).toBe(1);
  });

  it('refuse d’émettre quand la réserve de numéros est épuisée', async () => {
    const petite = new DepotNode();
    amorcerTerminal(petite, { taillePlage: 2 });
    const h = new HorlogeHLC(TERMINAL_TEST);

    const ctx = () => ({ ...contexte(), hlc: h.tick() });
    await emettreFacture(petite, ctx(), { clientNom: 'A', lignes: LIGNES });
    await emettreFacture(petite, ctx(), { clientNom: 'B', lignes: LIGNES });

    await expect(emettreFacture(petite, ctx(), { clientNom: 'C', lignes: LIGNES })).rejects.toThrow(
      /réserve de numéros|Aucun numéro/i,
    );

    // La réserve épuisée bloque l'émission, mais ne perd rien de ce qui a été
    // émis avant : c'est un arrêt propre, pas une corruption.
    expect(petite.interroger('SELECT id FROM factures')).toHaveLength(2);
    petite.fermer();
  });

  it('ne consomme pas de numéro quand l’émission échoue', async () => {
    const plageAvant = plageActive(base, TERMINAL_TEST)!;

    await expect(
      emettreFacture(base, contexte(), { clientNom: 'X', lignes: [] }),
    ).rejects.toThrow();

    const plageApres = plageActive(base, TERMINAL_TEST)!;
    expect(plageApres.curseur).toBe(plageAvant.curseur);
    expect(base.interroger('SELECT id FROM factures')).toHaveLength(0);
    expect(compterEnAttente(base)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('endurance — 500 factures hors ligne', () => {
  it('produit 500 factures sans trou, sans doublon et avec une chaîne intacte', async () => {
    const factures = await emettre(500);

    // 1. Numérotation : continue, sans doublon.
    const compteurs = factures.map((f) => Number(f.numero.split('-').at(-1)));
    const continuite = verifierContinuite(compteurs);
    expect(continuite.doublons).toEqual([]);
    expect(continuite.trous).toEqual([]);
    expect(continuite.continue).toBe(true);
    expect(factures[0]!.numero).toBe('PDV01-2026-000001');
    expect(factures.at(-1)!.numero).toBe('PDV01-2026-000500');

    // 2. Chaîne d'intégrité : rejouable de bout en bout.
    const verification = await verifierChaine(factures);
    expect(verification.anomalies).toEqual([]);
    expect(verification.valide).toBe(true);

    // 3. Outbox : une commande par facture, aucune perdue.
    expect(compterEnAttente(base)).toBe(500);

    // 4. Réserve : exactement 500 numéros consommés.
    expect(numerosRestants(plageActive(base, TERMINAL_TEST)!)).toBe(500);

    // 5. Unicité en base, garantie par l'index unique.
    const distincts = base.interroger<{ n: number }>(
      'SELECT COUNT(DISTINCT numero) AS n FROM factures',
    );
    expect(distincts[0]!.n).toBe(500);
  }, 120_000);

  it('garde des montants justes sur tout le volume', async () => {
    const factures = await emettre(500);
    const totalAttendu = 500 * 29_678; // 25 700 HT + 3 978 de TVA

    const [somme] = base.interroger<{ ttc: number }>('SELECT SUM(total_ttc) AS ttc FROM factures');
    expect(somme!.ttc).toBe(totalAttendu);
    expect(factures.every((f) => Number.isInteger(f.totaux.totalTTC))).toBe(true);
  }, 120_000);
});

/* ------------------------------------------------------------------ */

describe('réseau adverse', () => {
  it('reprend les commandes interrompues en plein envoi', async () => {
    await emettre(10);

    // Un lot est marqué « en cours », puis l'appareil s'éteint : réseau coupé
    // après l'envoi mais avant la réponse.
    const lot = prochainLot(base, 5);
    marquerEnCours(
      base,
      lot.map((l) => l.id),
    );
    expect(compterEnAttente(base)).toBe(10);

    // Redémarrage.
    const reprises = recupererCommandesInterrompues(base);
    expect(reprises).toBe(5);

    // Tout est de nouveau envoyable : rien n'est resté bloqué.
    expect(prochainLot(base, 50)).toHaveLength(10);
  });

  it('replanifie sans perdre la commande quand le serveur répond en erreur', async () => {
    await emettre(3);
    const lot = prochainLot(base, 3);

    const echecs: ResultatCommande[] = lot.map((l) => ({
      commandeId: l.id,
      accepte: false,
      motif: 'Service momentanément indisponible.',
      definitif: false,
    }));
    appliquerResultats(base, echecs);

    // Toujours en attente, avec un délai de repli posé.
    expect(compterEnAttente(base)).toBe(3);
    expect(compterEchecsDefinitifs(base)).toBe(0);
    expect(prochainLot(base, 10)).toHaveLength(0);

    // Le réseau revient : les délais accumulés n'ont plus lieu d'être.
    expect(relancerImmediatement(base)).toBe(3);
    expect(prochainLot(base, 10)).toHaveLength(3);
  });

  it('abandonne après trop d’échecs, et le signale au lieu de réessayer sans fin', async () => {
    await emettre(1);
    const [commande] = prochainLot(base, 1);

    for (let i = 0; i < 12; i++) {
      appliquerResultats(base, [
        { commandeId: commande!.id, accepte: false, motif: 'Erreur serveur', definitif: false },
      ]);
      relancerImmediatement(base);
    }

    expect(compterEchecsDefinitifs(base)).toBe(1);
    expect(compterEnAttente(base)).toBe(0);
  });

  it('marque la facture « à corriger » sur un refus définitif, avec le motif', async () => {
    const [facture] = await emettre(1);
    const [commande] = prochainLot(base, 1);

    appliquerResultats(base, [
      {
        commandeId: commande!.id,
        accepte: false,
        motif: 'Le numéro est déjà utilisé par une autre facture.',
        definitif: true,
      },
    ]);

    const [enBase] = base.interroger<{ statut: string; motif_rejet: string }>(
      'SELECT statut, motif_rejet FROM factures WHERE id = ?',
      [facture!.id],
    );
    expect(enBase!.statut).toBe('REJETEE');
    expect(enBase!.motif_rejet).toContain('déjà utilisé');
  });

  it('ne perd rien quand un lot est acquitté deux fois', async () => {
    await emettre(5);
    const lot = prochainLot(base, 5);
    const succes: ResultatCommande[] = lot.map((l) => ({ commandeId: l.id, accepte: true }));

    appliquerResultats(base, succes);
    appliquerResultats(base, succes); // rejeu de la même réponse

    expect(compterEnAttente(base)).toBe(0);
    expect(compterEchecsDefinitifs(base)).toBe(0);

    const statuts = base.interroger<{ statut: string; n: number }>(
      'SELECT statut, COUNT(*) AS n FROM factures GROUP BY statut',
    );
    expect(statuts).toEqual([{ statut: 'EN_FILE_DGI', n: 5 }]);
  });

  it('respecte l’ordre d’émission dans les lots envoyés', async () => {
    const factures = await emettre(60);
    const envoyes: string[] = [];

    for (let i = 0; i < 3; i++) {
      const lot = prochainLot(base, 25);
      envoyes.push(
        ...lot.map((l) => (JSON.parse(l.charge_json) as { facture: Facture }).facture.numero),
      );
      appliquerResultats(
        base,
        lot.map((l) => ({ commandeId: l.id, accepte: true })),
      );
    }

    expect(envoyes).toEqual(factures.map((f) => f.numero));
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe('horloge déréglée', () => {
  it('conserve un ordre d’émission correct quand l’horloge recule', async () => {
    let maintenant = Date.UTC(2026, 5, 15, 9, 0, 0);
    const h = new HorlogeHLC(TERMINAL_TEST, () => maintenant);

    const horodatages = [h.tick()];
    maintenant -= 3_600_000; // l'utilisateur recule l'heure d'une heure
    horodatages.push(h.tick());
    horodatages.push(h.tick());

    // Malgré le recul de l'horloge murale, l'ordre logique reste croissant.
    for (let i = 1; i < horodatages.length; i++) {
      const precedent = horodatages[i - 1]!;
      const courant = horodatages[i]!;
      const croissant =
        courant.murale > precedent.murale ||
        (courant.murale === precedent.murale && courant.compteur > precedent.compteur);
      expect(croissant).toBe(true);
    }
  });

  it('signale une dérive excessive avec l’heure serveur', () => {
    const h = new HorlogeHLC(TERMINAL_TEST, () => 1_000_000);
    expect(h.recaler(1_000_500).deriveExcessive).toBe(false);
    expect(h.recaler(1_000_000 + 20 * 60_000).deriveExcessive).toBe(true);
  });

  it('facture quand même avec une horloge système ramenée à 2020', async () => {
    // Scénario réel : batterie retirée, l'horloge revient à une date de
    // fabrication. Sans correction, aucun référentiel fiscal ne s'appliquerait
    // et le commerçant serait bloqué. L'horloge logique, recalée sur l'heure
    // serveur à la dernière synchronisation, rattrape l'écart.
    const horlogeFausse = new HorlogeHLC(TERMINAL_TEST, () => Date.UTC(2020, 0, 1));
    const heureServeur = Date.UTC(2026, 5, 15, 10, 0, 0);
    const recalage = horlogeFausse.recaler(heureServeur);

    expect(recalage.deriveExcessive).toBe(true);

    const facture = await emettreFacture(
      base,
      { ...contexte(), hlc: horlogeFausse.tick() },
      { clientNom: 'Client', lignes: LIGNES },
    );

    expect(facture.emiseLe.startsWith('2026-06-15')).toBe(true);
    expect(facture.numero).toBe('PDV01-2026-000001');
    expect(facture.totaux.totalTVA).toBe(3_978);
  });

  it('numérote indépendamment de l’horloge', async () => {
    // La numérotation vient de la réserve allouée par le serveur, jamais d'un
    // horodatage : une horloge fausse ne peut pas créer de trou ni de doublon.
    const h1 = new HorlogeHLC(TERMINAL_TEST, () => Date.UTC(2026, 0, 1));
    const h2 = new HorlogeHLC(TERMINAL_TEST, () => Date.UTC(2026, 11, 31));

    const a = await emettreFacture(
      base,
      { ...contexte(), hlc: h1.tick() },
      {
        clientNom: 'A',
        lignes: LIGNES,
      },
    );
    const b = await emettreFacture(
      base,
      { ...contexte(), hlc: h2.tick() },
      {
        clientNom: 'B',
        lignes: LIGNES,
      },
    );

    expect(a.numero).toBe('PDV01-2026-000001');
    expect(b.numero).toBe('PDV01-2026-000002');
  });
});

/* ------------------------------------------------------------------ */

describe('anomalies et stockage', () => {
  it('ne signale rien quand tout va bien', async () => {
    await emettre(3);
    expect(listerAnomalies(base, TERMINAL_TEST)).toEqual([]);
  });

  it('signale la réserve épuisée comme bloquante', async () => {
    const petite = new DepotNode();
    amorcerTerminal(petite, { taillePlage: 1 });
    const h = new HorlogeHLC(TERMINAL_TEST);
    await emettreFacture(
      petite,
      { ...contexte(), hlc: h.tick() },
      {
        clientNom: 'A',
        lignes: LIGNES,
      },
    );

    const anomalies = listerAnomalies(petite, TERMINAL_TEST);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.gravite).toBe('BLOQUANT');
    expect(anomalies[0]!.action).toMatch(/Connectez-vous/);
    petite.fermer();
  });

  it('signale une facture refusée avec son motif, et propose quoi faire', async () => {
    await emettre(1);
    const [commande] = prochainLot(base, 1);
    appliquerResultats(base, [
      {
        commandeId: commande!.id,
        accepte: false,
        motif: 'Le numéro est déjà utilisé par une autre facture.',
        definitif: true,
      },
    ]);

    const anomalies = listerAnomalies(base, TERMINAL_TEST);
    const facture = anomalies.find((a) => a.id.startsWith('facture-'));
    expect(facture?.detail).toContain('déjà utilisé');
    expect(facture?.action).toBeTruthy();
  });

  it('remet en file une commande abandonnée sur demande de l’utilisateur', async () => {
    await emettre(1);
    const [commande] = prochainLot(base, 1);

    for (let i = 0; i < 12; i++) {
      appliquerResultats(base, [
        { commandeId: commande!.id, accepte: false, motif: 'Erreur', definitif: false },
      ]);
      relancerImmediatement(base);
    }
    expect(compterEchecsDefinitifs(base)).toBe(1);

    const anomalie = listerAnomalies(base, TERMINAL_TEST).find((a) => a.id.startsWith('commande-'));
    expect(reessayerCommande(base, anomalie!.id)).toBe(true);

    expect(compterEchecsDefinitifs(base)).toBe(0);
    expect(prochainLot(base, 10)).toHaveLength(1);
  });

  it('purge les envois confirmés mais ne touche JAMAIS aux factures', async () => {
    await emettre(5);
    const lot = prochainLot(base, 5);
    appliquerResultats(
      base,
      lot.map((l) => ({ commandeId: l.id, accepte: true })),
    );

    // On vieillit artificiellement les commandes confirmées.
    const ancien = new Date(Date.now() - 60 * 86_400_000).toISOString();
    base.executer(`UPDATE outbox SET creee_le = ?`, [ancien]);

    const avant = etatStockage(base);
    expect(avant.facturesConservees).toBe(5);
    expect(avant.commandesConfirmees).toBe(5);

    const purge = purgerStockage(base);
    expect(purge.commandesPurgees).toBe(5);

    const apres = etatStockage(base);
    expect(apres.commandesConfirmees).toBe(0);
    expect(apres.facturesConservees, 'les factures ne sont jamais purgées').toBe(5);
  });

  it('ne purge pas une commande encore en attente, même ancienne', async () => {
    await emettre(3);
    base.executer(`UPDATE outbox SET creee_le = ?`, [
      new Date(Date.now() - 365 * 86_400_000).toISOString(),
    ]);

    expect(purgerStockage(base).commandesPurgees).toBe(0);
    expect(compterEnAttente(base)).toBe(3);
  });
});

describe('déduplication des anomalies', () => {
  it('ne compte qu’une anomalie quand une facture est refusée définitivement', async () => {
    await emettre(1);
    const [commande] = prochainLot(base, 1);

    // Le serveur refuse : la facture passe « à corriger » ET la commande passe
    // en échec définitif. C'est un seul incident, pas deux.
    appliquerResultats(base, [
      {
        commandeId: commande!.id,
        accepte: false,
        motif: 'Le numéro est déjà utilisé par une autre facture.',
        definitif: true,
      },
    ]);

    const anomalies = listerAnomalies(base, TERMINAL_TEST);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.id.startsWith('facture-')).toBe(true);
  });

  it('liste séparément une commande en échec qui ne porte pas de facture', async () => {
    await emettre(1);
    const [facture] = prochainLot(base, 1);

    // Une commande d'un autre type, elle, garde son entrée propre.
    base.executer(
      `INSERT INTO outbox (id, type, entreprise_id, terminal_id, hlc, creee_le, charge_json, etat, derniere_erreur)
       VALUES (?, 'UPSERT_CLIENT', ?, ?, ?, ?, ?, 'ECHEC_DEFINITIF', ?)`,
      [
        'commande-client-ko',
        ENTREPRISE_TEST,
        TERMINAL_TEST,
        '000000000000001:00000:t',
        new Date().toISOString(),
        JSON.stringify({ client: { id: 'c1', nom: 'X' } }),
        'Refus du serveur',
      ],
    );
    appliquerResultats(base, [
      { commandeId: facture!.id, accepte: false, motif: 'Numéro déjà utilisé.', definitif: true },
    ]);

    const anomalies = listerAnomalies(base, TERMINAL_TEST);
    expect(anomalies).toHaveLength(2);
    expect(anomalies.filter((a) => a.id.startsWith('facture-'))).toHaveLength(1);
    expect(anomalies.filter((a) => a.id.startsWith('commande-'))).toHaveLength(1);
  });
});
