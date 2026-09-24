/**
 * Référentiel clients, côté terminal.
 *
 * Création et modification fonctionnent intégralement hors ligne : la fiche est
 * écrite en base locale et la commande correspondante est empilée dans l'outbox,
 * dans la même transaction. Le caissier n'attend jamais le réseau pour
 * enregistrer un client pendant qu'une personne est devant lui.
 */

import {
  comparerHLC,
  deserialiserHLC,
  serialiserHLC,
  uuidv7,
  type Client,
  type HorodatageHLC,
} from '@fneplus/core';
import type { DepotLocal } from '../db/depot-local';
import { empiler } from '../outbox';

export interface SaisieClient {
  /** Absent à la création, renseigné à la modification. */
  id?: string;
  nom: string;
  ncc?: string;
  telephone?: string;
  email?: string;
  adresse?: string;
}

export interface LigneClient {
  id: string;
  nom: string;
  ncc: string | null;
  telephone: string | null;
  email: string | null;
  adresse: string | null;
}

export class ErreurClient extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurClient';
  }
}

export function enregistrerClient(
  base: DepotLocal,
  contexte: { entrepriseId: string; terminalId: string; hlc: HorodatageHLC },
  saisie: SaisieClient,
): Client {
  const nom = saisie.nom.trim();
  if (nom.length < 2) {
    throw new ErreurClient('Le nom du client est obligatoire.');
  }

  const client: Client = {
    id: saisie.id ?? uuidv7(),
    entrepriseId: contexte.entrepriseId,
    nom,
    ...(saisie.ncc?.trim() ? { ncc: saisie.ncc.trim().toUpperCase() } : {}),
    ...(saisie.telephone?.trim() ? { telephone: saisie.telephone.trim() } : {}),
    ...(saisie.email?.trim() ? { email: saisie.email.trim() } : {}),
    ...(saisie.adresse?.trim() ? { adresse: saisie.adresse.trim() } : {}),
  };

  const hlcSerialise = serialiserHLC(contexte.hlc);

  // Fiche et commande de synchronisation écrites ensemble : l'appareil ne peut
  // pas s'éteindre entre les deux et laisser un client qui ne partira jamais.
  base.transaction(() => {
    base.executer(
      `INSERT INTO clients (id, entreprise_id, nom, ncc, telephone, email, adresse, hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         nom = excluded.nom, ncc = excluded.ncc, telephone = excluded.telephone,
         email = excluded.email, adresse = excluded.adresse, hlc = excluded.hlc`,
      [
        client.id,
        client.entrepriseId,
        client.nom,
        client.ncc ?? null,
        client.telephone ?? null,
        client.email ?? null,
        client.adresse ?? null,
        hlcSerialise,
      ],
    );

    empiler(base, {
      id: uuidv7(),
      type: 'UPSERT_CLIENT',
      entrepriseId: contexte.entrepriseId,
      terminalId: contexte.terminalId,
      hlc: contexte.hlc,
      creeeLe: new Date().toISOString(),
      charge: { client },
    });

    base.journaliser('CLIENT_ENREGISTRE', { id: client.id, nom: client.nom });
  });

  return client;
}

export function listerClients(
  base: DepotLocal,
  entrepriseId: string,
  recherche?: string,
): LigneClient[] {
  if (recherche?.trim()) {
    const motif = `%${recherche.trim()}%`;
    return base.interroger<LigneClient>(
      `SELECT id, nom, ncc, telephone, email, adresse FROM clients
        WHERE entreprise_id = ? AND supprime = 0 AND (nom LIKE ? OR telephone LIKE ?)
        ORDER BY nom COLLATE NOCASE LIMIT 50`,
      [entrepriseId, motif, motif],
    );
  }

  return base.interroger<LigneClient>(
    `SELECT id, nom, ncc, telephone, email, adresse FROM clients
      WHERE entreprise_id = ? AND supprime = 0
      ORDER BY nom COLLATE NOCASE LIMIT 50`,
    [entrepriseId],
  );
}

export function compterClients(base: DepotLocal, entrepriseId: string): number {
  const lignes = base.interroger<{ n: number }>(
    'SELECT COUNT(*) AS n FROM clients WHERE entreprise_id = ? AND supprime = 0',
    [entrepriseId],
  );
  return lignes[0]?.n ?? 0;
}

/**
 * Applique le delta descendant reçu du serveur.
 *
 * Une fiche locale plus récente n'est pas écrasée : un caissier qui vient de
 * corriger un numéro hors ligne ne doit pas voir sa correction disparaître parce
 * que le serveur renvoie une version antérieure encore en cache.
 */
export function appliquerDeltaClients(
  base: DepotLocal,
  entrepriseId: string,
  clients: {
    id: string;
    nom: string;
    ncc: string | null;
    telephone: string | null;
    email: string | null;
    adresse: string | null;
    hlc: string;
    supprime: boolean;
  }[],
): number {
  let appliques = 0;

  base.transaction(() => {
    for (const distant of clients) {
      const [local] = base.interroger<{ hlc: string }>('SELECT hlc FROM clients WHERE id = ?', [
        distant.id,
      ]);

      // Comparaison structurée, pas lexicographique : deux horodatages ne se
      // comparent correctement comme chaînes que si leurs champs sont remplis à
      // longueur fixe, ce qui dépend de qui les a écrits.
      if (local && comparerHLC(deserialiserHLC(local.hlc), deserialiserHLC(distant.hlc)) > 0) {
        continue;
      }

      base.executer(
        `INSERT INTO clients (id, entreprise_id, nom, ncc, telephone, email, adresse, hlc, supprime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           nom = excluded.nom, ncc = excluded.ncc, telephone = excluded.telephone,
           email = excluded.email, adresse = excluded.adresse,
           hlc = excluded.hlc, supprime = excluded.supprime`,
        [
          distant.id,
          entrepriseId,
          distant.nom,
          distant.ncc,
          distant.telephone,
          distant.email,
          distant.adresse,
          distant.hlc,
          distant.supprime ? 1 : 0,
        ],
      );
      appliques++;
    }
  });

  return appliques;
}
