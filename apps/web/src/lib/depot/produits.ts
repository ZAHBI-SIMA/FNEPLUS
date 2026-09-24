/**
 * Catalogue produits, côté terminal.
 *
 * Même principe que le répertoire clients : création et modification
 * fonctionnent hors ligne, la fiche et sa commande de synchronisation sont
 * écrites dans la même transaction.
 *
 * Le catalogue est ce qui rend la facturation rapide : choisir un article
 * enregistré évite de ressaisir désignation, prix et code de TVA à chaque vente.
 * C'est là que se gagnent les secondes promises par le cahier des charges.
 */

import {
  comparerHLC,
  deserialiserHLC,
  serialiserHLC,
  uuidv7,
  type CodeTVA,
  type HorodatageHLC,
  type Produit,
} from '@fneplus/core';
import type { BaseLocale } from '../db/base-locale';
import { empiler } from '../outbox';

export interface SaisieProduit {
  id?: string;
  designation: string;
  prixUnitaireHT: number;
  codeTva: CodeTVA;
  reference?: string;
}

export interface LigneProduit {
  id: string;
  designation: string;
  prix_unitaire_ht: number;
  code_tva: CodeTVA;
  reference: string | null;
}

export class ErreurProduit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurProduit';
  }
}

export function enregistrerProduit(
  base: BaseLocale,
  contexte: { entrepriseId: string; terminalId: string; hlc: HorodatageHLC },
  saisie: SaisieProduit,
): Produit {
  const designation = saisie.designation.trim();
  if (designation.length < 2) {
    throw new ErreurProduit('La désignation de l’article est obligatoire.');
  }
  if (!Number.isInteger(saisie.prixUnitaireHT) || saisie.prixUnitaireHT < 0) {
    throw new ErreurProduit('Le prix doit être un montant entier en francs CFA.');
  }

  const produit: Produit = {
    id: saisie.id ?? uuidv7(),
    entrepriseId: contexte.entrepriseId,
    designation,
    prixUnitaireHT: saisie.prixUnitaireHT,
    codeTva: saisie.codeTva,
    ...(saisie.reference?.trim() ? { reference: saisie.reference.trim() } : {}),
  };

  const hlcSerialise = serialiserHLC(contexte.hlc);

  base.transaction(() => {
    base.executer(
      `INSERT INTO produits (id, entreprise_id, designation, prix_unitaire_ht, code_tva, reference, hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         designation = excluded.designation, prix_unitaire_ht = excluded.prix_unitaire_ht,
         code_tva = excluded.code_tva, reference = excluded.reference, hlc = excluded.hlc`,
      [
        produit.id,
        produit.entrepriseId,
        produit.designation,
        produit.prixUnitaireHT,
        produit.codeTva,
        produit.reference ?? null,
        hlcSerialise,
      ],
    );

    empiler(base, {
      id: uuidv7(),
      type: 'UPSERT_PRODUIT',
      entrepriseId: contexte.entrepriseId,
      terminalId: contexte.terminalId,
      hlc: contexte.hlc,
      creeeLe: new Date().toISOString(),
      charge: { produit },
    });

    base.journaliser('PRODUIT_ENREGISTRE', { id: produit.id, designation: produit.designation });
  });

  return produit;
}

export function listerProduits(
  base: BaseLocale,
  entrepriseId: string,
  recherche?: string,
): LigneProduit[] {
  if (recherche?.trim()) {
    const motif = `%${recherche.trim()}%`;
    return base.interroger<LigneProduit>(
      `SELECT id, designation, prix_unitaire_ht, code_tva, reference FROM produits
        WHERE entreprise_id = ? AND supprime = 0 AND (designation LIKE ? OR reference LIKE ?)
        ORDER BY designation COLLATE NOCASE LIMIT 50`,
      [entrepriseId, motif, motif],
    );
  }

  return base.interroger<LigneProduit>(
    `SELECT id, designation, prix_unitaire_ht, code_tva, reference FROM produits
      WHERE entreprise_id = ? AND supprime = 0
      ORDER BY designation COLLATE NOCASE LIMIT 50`,
    [entrepriseId],
  );
}

export function compterProduits(base: BaseLocale, entrepriseId: string): number {
  const lignes = base.interroger<{ n: number }>(
    'SELECT COUNT(*) AS n FROM produits WHERE entreprise_id = ? AND supprime = 0',
    [entrepriseId],
  );
  return lignes[0]?.n ?? 0;
}

/** Applique le delta descendant reçu du serveur, sans écraser une version locale plus récente. */
export function appliquerDeltaProduits(
  base: BaseLocale,
  entrepriseId: string,
  produits: {
    id: string;
    designation: string;
    prix_unitaire_ht: number;
    code_tva: string;
    reference: string | null;
    hlc: string;
    supprime: boolean;
  }[],
): number {
  let appliques = 0;

  base.transaction(() => {
    for (const distant of produits) {
      const [local] = base.interroger<{ hlc: string }>('SELECT hlc FROM produits WHERE id = ?', [
        distant.id,
      ]);

      if (local && comparerHLC(deserialiserHLC(local.hlc), deserialiserHLC(distant.hlc)) > 0) {
        continue;
      }

      base.executer(
        `INSERT INTO produits (id, entreprise_id, designation, prix_unitaire_ht, code_tva,
                               reference, hlc, supprime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           designation = excluded.designation, prix_unitaire_ht = excluded.prix_unitaire_ht,
           code_tva = excluded.code_tva, reference = excluded.reference,
           hlc = excluded.hlc, supprime = excluded.supprime`,
        [
          distant.id,
          entrepriseId,
          distant.designation,
          distant.prix_unitaire_ht,
          distant.code_tva,
          distant.reference,
          distant.hlc,
          distant.supprime ? 1 : 0,
        ],
      );
      appliques++;
    }
  });

  return appliques;
}
