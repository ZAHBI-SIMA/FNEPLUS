/**
 * Outbox local — file des commandes à pousser au serveur.
 *
 * Invariant : une commande est écrite ici dans la MÊME transaction que la
 * modification de l'état local qu'elle décrit. Si l'application est tuée entre
 * les deux (batterie vide en pleine vente, ce qui arrive), on ne peut pas se
 * retrouver avec une facture enregistrée qui ne partira jamais, ni avec une
 * commande qui décrit une facture inexistante.
 */

import {
  delaiAvantNouvelleTentative,
  MAX_TENTATIVES,
  serialiserHLC,
  type Commande,
  type EtatCommande,
  type ResultatCommande,
} from '@fneplus/core';
import type { BaseLocale } from './db/base-locale';

interface LigneOutbox {
  id: string;
  type: string;
  entreprise_id: string;
  terminal_id: string;
  hlc: string;
  creee_le: string;
  charge_json: string;
  etat: EtatCommande;
  tentatives: number;
  prochaine_tentative_le: string | null;
  derniere_erreur: string | null;
}

/** Empile une commande. À appeler DANS la transaction qui modifie l'état local. */
export function empiler(base: BaseLocale, commande: Commande): void {
  base.executer(
    `INSERT INTO outbox (id, type, entreprise_id, terminal_id, hlc, creee_le, charge_json, etat)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'EN_ATTENTE')`,
    [
      commande.id,
      commande.type,
      commande.entrepriseId,
      commande.terminalId,
      serialiserHLC(commande.hlc),
      commande.creeeLe,
      JSON.stringify(commande.charge),
    ],
  );
}

export function compterEnAttente(base: BaseLocale): number {
  const lignes = base.interroger<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox WHERE etat IN ('EN_ATTENTE', 'EN_COURS')`,
  );
  return lignes[0]?.n ?? 0;
}

export function compterEchecsDefinitifs(base: BaseLocale): number {
  const lignes = base.interroger<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox WHERE etat = 'ECHEC_DEFINITIF'`,
  );
  return lignes[0]?.n ?? 0;
}

/**
 * Prochain lot à envoyer.
 *
 * Trié par date de création : l'ordre d'émission des factures est préservé côté
 * serveur, ce qui garde la chaîne d'intégrité vérifiable sans retri.
 */
export function prochainLot(base: BaseLocale, taille = 25): LigneOutbox[] {
  const maintenant = new Date().toISOString();
  return base.interroger<LigneOutbox>(
    `SELECT * FROM outbox
      WHERE etat = 'EN_ATTENTE'
        AND (prochaine_tentative_le IS NULL OR prochaine_tentative_le <= ?)
      ORDER BY creee_le ASC
      LIMIT ?`,
    [maintenant, taille],
  );
}

export function marquerEnCours(base: BaseLocale, ids: string[]): void {
  if (ids.length === 0) return;
  const parametres = ids.map(() => '?').join(',');
  base.executer(`UPDATE outbox SET etat = 'EN_COURS' WHERE id IN (${parametres})`, ids);
}

/**
 * Applique la réponse du serveur à un lot.
 *
 * Répercute aussi le sort de chaque commande sur l'objet métier qu'elle
 * décrivait : une facture acquittée par le serveur ne doit plus s'afficher
 * comme « gardée sur l'appareil ». Sans cela, le bandeau annonce « tout est
 * transmis » pendant que la liste affiche le contraire — et c'est précisément
 * sur cet écran que se joue la confiance du commerçant.
 */
export function appliquerResultats(base: BaseLocale, resultats: ResultatCommande[]): void {
  base.transaction(() => {
    for (const resultat of resultats) {
      const [commande] = base.interroger<{ type: string; charge_json: string }>(
        'SELECT type, charge_json FROM outbox WHERE id = ?',
        [resultat.commandeId],
      );

      if (resultat.accepte) {
        base.executer(`UPDATE outbox SET etat = 'CONFIRMEE', derniere_erreur = NULL WHERE id = ?`, [
          resultat.commandeId,
        ]);
        if (commande) majStatutFacture(base, commande, 'EN_FILE_DGI');
        continue;
      }

      if (resultat.definitif) {
        base.executer(
          `UPDATE outbox SET etat = 'ECHEC_DEFINITIF', derniere_erreur = ? WHERE id = ?`,
          [resultat.motif ?? 'Refus définitif du serveur', resultat.commandeId],
        );
        // Refus définitif : la facture demande une intervention humaine, on le
        // dit avec le motif renvoyé par le serveur plutôt qu'un code d'erreur.
        if (commande) majStatutFacture(base, commande, 'REJETEE', resultat.motif);
        base.journaliser('OUTBOX_ECHEC_DEFINITIF', resultat);
        continue;
      }

      replanifier(base, resultat.commandeId, resultat.motif ?? 'Échec temporaire');
    }
  });
}

/**
 * Reporte le sort d'une commande sur la facture qu'elle portait.
 *
 * Le statut local ne « redescend » jamais : une facture déjà certifiée par la
 * DGI ne repasse pas « en file » parce qu'un rejeu tardif a été acquitté.
 */
function majStatutFacture(
  base: BaseLocale,
  commande: { type: string; charge_json: string },
  statut: 'EN_FILE_DGI' | 'REJETEE',
  motif?: string,
): void {
  if (commande.type !== 'CREER_FACTURE') return;

  let factureId: string | undefined;
  try {
    factureId = (JSON.parse(commande.charge_json) as { facture?: { id?: string } }).facture?.id;
  } catch {
    return;
  }
  if (!factureId) return;

  base.executer(
    `UPDATE factures SET statut = ?, motif_rejet = ?
      WHERE id = ? AND statut IN ('EMISE_LOCALEMENT', 'EN_FILE_DGI')`,
    [statut, motif ?? null, factureId],
  );
}

/**
 * Replanifie une commande après un échec temporaire.
 * Au-delà de MAX_TENTATIVES, elle bascule en échec définitif et remonte à
 * l'utilisateur : on ne réessaie pas indéfiniment en silence.
 */
export function replanifier(base: BaseLocale, commandeId: string, erreur: string): void {
  const lignes = base.interroger<{ tentatives: number }>(
    'SELECT tentatives FROM outbox WHERE id = ?',
    [commandeId],
  );
  const tentatives = (lignes[0]?.tentatives ?? 0) + 1;

  if (tentatives >= MAX_TENTATIVES) {
    base.executer(
      `UPDATE outbox SET etat = 'ECHEC_DEFINITIF', tentatives = ?, derniere_erreur = ? WHERE id = ?`,
      [tentatives, erreur, commandeId],
    );
    base.journaliser('OUTBOX_ABANDON', { commandeId, tentatives, erreur });
    return;
  }

  const prochaine = new Date(Date.now() + delaiAvantNouvelleTentative(tentatives)).toISOString();
  base.executer(
    `UPDATE outbox
        SET etat = 'EN_ATTENTE', tentatives = ?, prochaine_tentative_le = ?, derniere_erreur = ?
      WHERE id = ?`,
    [tentatives, prochaine, erreur, commandeId],
  );
}

/**
 * Remet en attente les commandes restées « en cours ».
 *
 * À appeler au démarrage : une commande dans cet état signifie que l'envoi a été
 * interrompu (onglet fermé, batterie vide, réseau coupé en plein POST). Elle est
 * renvoyée telle quelle — l'idempotence côté serveur évite le doublon.
 */
export function recupererCommandesInterrompues(base: BaseLocale): number {
  const lignes = base.interroger<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox WHERE etat = 'EN_COURS'`,
  );
  const nombre = lignes[0]?.n ?? 0;
  if (nombre > 0) {
    base.executer(`UPDATE outbox SET etat = 'EN_ATTENTE' WHERE etat = 'EN_COURS'`);
    base.journaliser('OUTBOX_REPRISE', { nombre });
  }
  return nombre;
}

/**
 * Annule les délais d'attente en cours.
 *
 * Le repli exponentiel sert à ne pas marteler un serveur en difficulté. Quand
 * c'est le TERMINAL qui était hors ligne, ce délai n'a pas lieu d'être : dès que
 * le réseau revient, ou que l'utilisateur demande explicitement l'envoi, les
 * commandes repartent sans attendre.
 */
export function relancerImmediatement(base: BaseLocale): number {
  const lignes = base.interroger<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox
      WHERE etat = 'EN_ATTENTE' AND prochaine_tentative_le IS NOT NULL`,
  );
  base.executer(
    `UPDATE outbox SET prochaine_tentative_le = NULL
      WHERE etat = 'EN_ATTENTE' AND prochaine_tentative_le IS NOT NULL`,
  );
  return lignes[0]?.n ?? 0;
}

/** Purge les commandes confirmées anciennes, pour borner la taille de la base. */
export function purgerConfirmees(base: BaseLocale, joursRetention = 30): number {
  const limite = new Date(Date.now() - joursRetention * 86_400_000).toISOString();
  const avant = base.interroger<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox WHERE etat = 'CONFIRMEE' AND creee_le < ?`,
    [limite],
  );
  base.executer(`DELETE FROM outbox WHERE etat = 'CONFIRMEE' AND creee_le < ?`, [limite]);
  return avant[0]?.n ?? 0;
}
