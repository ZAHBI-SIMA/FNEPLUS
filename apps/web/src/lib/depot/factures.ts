/**
 * Émission d'une facture sur le terminal.
 *
 * C'est le chemin critique du produit, et il ne touche jamais le réseau. La
 * séquence complète — calcul de TVA, consommation d'un numéro, chaînage
 * d'intégrité, écriture de la facture, mise en file pour la DGI — se déroule
 * intégralement en local, dans UNE transaction.
 *
 * Ce que garantit cette transaction : si l'appareil s'éteint à n'importe quel
 * instant, on ne peut jamais obtenir un numéro consommé sans facture, une
 * facture sans commande de transmission, ni deux factures portant le même
 * numéro.
 */

import {
  calculerFacture,
  calculerHash,
  construireContenuQR,
  consommerNumero,
  HASH_GENESE,
  uuidv7,
  type Facture,
  type HorodatageHLC,
  type LigneFacture,
  type PlageNumeros,
  type RegimeFiscal,
  type TypeDocument,
  type VersionReferentielFiscal,
} from '@fneplus/core';
import type { BaseLocale } from '../db/base-locale';
import { empiler } from '../outbox';

export interface ContexteEmission {
  entrepriseId: string;
  /** NCC de l'émetteur, encodé dans le QR. */
  ncc: string;
  pointDeVenteId: string;
  terminalId: string;
  regimeFiscal: RegimeFiscal;
  hlc: HorodatageHLC;
  referentiels?: VersionReferentielFiscal[];
}

export interface DemandeFacture {
  type?: TypeDocument;
  clientNom: string;
  clientId?: string;
  clientNcc?: string;
  lignes: Omit<LigneFacture, 'id'>[];
  factureOrigineId?: string;
}

/* ------------------------------------------------------------------ */
/* Lectures                                                            */
/* ------------------------------------------------------------------ */

interface LignePlage {
  id: string;
  entreprise_id: string;
  point_de_vente_id: string;
  terminal_id: string;
  prefixe: string;
  debut: number;
  fin: number;
  curseur: number;
  longueur_compteur: number;
  allouee_le: string;
  cloturee_le: string | null;
}

function versPlage(l: LignePlage): PlageNumeros {
  return {
    id: l.id,
    entrepriseId: l.entreprise_id,
    pointDeVenteId: l.point_de_vente_id,
    terminalId: l.terminal_id,
    prefixe: l.prefixe,
    debut: l.debut,
    fin: l.fin,
    curseur: l.curseur,
    longueurCompteur: l.longueur_compteur,
    allouceLe: l.allouee_le,
    ...(l.cloturee_le ? { clotureeLe: l.cloturee_le } : {}),
  };
}

/** Plage active du terminal : la plus ancienne non clôturée et non épuisée. */
export function plageActive(base: BaseLocale, terminalId: string): PlageNumeros | null {
  const lignes = base.interroger<LignePlage>(
    `SELECT * FROM plages_numeros
      WHERE terminal_id = ? AND cloturee_le IS NULL AND curseur <= fin
      ORDER BY allouee_le ASC
      LIMIT 1`,
    [terminalId],
  );
  const ligne = lignes[0];
  return ligne ? versPlage(ligne) : null;
}

/** Hash de la dernière facture de l'entreprise, pour chaîner la suivante. */
export function dernierHash(base: BaseLocale, entrepriseId: string): string {
  const lignes = base.interroger<{ hash: string }>(
    `SELECT hash FROM factures
      WHERE entreprise_id = ?
      ORDER BY emise_le DESC, numero DESC
      LIMIT 1`,
    [entrepriseId],
  );
  return lignes[0]?.hash ?? HASH_GENESE;
}

export class ErreurEmission extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurEmission';
  }
}

/* ------------------------------------------------------------------ */
/* Émission                                                            */
/* ------------------------------------------------------------------ */

export async function emettreFacture(
  base: BaseLocale,
  contexte: ContexteEmission,
  demande: DemandeFacture,
): Promise<Facture> {
  const plage = plageActive(base, contexte.terminalId);
  if (!plage) {
    throw new ErreurEmission(
      'Aucun numéro disponible sur ce terminal. Connectez-vous quelques secondes pour recharger une réserve.',
    );
  }

  const emiseLe = new Date().toISOString();

  // 1. Calcul fiscal — avec le référentiel en vigueur à la date d'émission.
  const calcul = calculerFacture(
    demande.lignes.map((l, index) => ({ ...l, id: `tmp-${index}` })),
    {
      dateEmission: emiseLe,
      regimeFiscal: contexte.regimeFiscal,
      ...(contexte.referentiels ? { versionsReferentiel: contexte.referentiels } : {}),
    },
  );

  // 2. Réservation du numéro (en mémoire : rien n'est écrit avant la transaction).
  const { numero, plage: plageApres } = consommerNumero(plage);

  // 3. Chaînage d'intégrité.
  const lignes: LigneFacture[] = demande.lignes.map((l) => ({ ...l, id: uuidv7() }));
  const factureId = uuidv7();

  const sansHash = {
    entrepriseId: contexte.entrepriseId,
    pointDeVenteId: contexte.pointDeVenteId,
    terminalId: contexte.terminalId,
    type: demande.type ?? ('FACTURE' as TypeDocument),
    numero,
    emiseLe,
    clientNom: demande.clientNom,
    ...(demande.clientId ? { clientId: demande.clientId } : {}),
    ...(demande.clientNcc ? { clientNcc: demande.clientNcc } : {}),
    lignes,
    totaux: calcul.totaux,
    versionReferentielFiscal: calcul.versionReferentielFiscal,
    hashPrecedent: dernierHash(base, contexte.entrepriseId),
    ...(demande.factureOrigineId ? { factureOrigineId: demande.factureOrigineId } : {}),
  };

  const hash = await calculerHash(sansHash);

  const facture: Facture = {
    ...sansHash,
    id: factureId,
    // Statut immédiat : le document est remis au client, il n'est plus modifiable.
    statut: 'EMISE_LOCALEMENT',
    hash,
  };

  // 3 bis. QR remis au client immédiatement, sans attendre le réseau. Il est
  // marqué provisoire tant que la DGI n'a pas renvoyé d'identifiant de
  // certification — l'interface le dit, plutôt que de laisser croire à une
  // conformité déjà acquise.
  const qr = construireContenuQR(facture, contexte.ncc);
  facture.contenuQR = qr.contenu;

  // 4. Écriture atomique : facture + lignes + avancée du curseur + commande de
  //    transmission. Tout, ou rien.
  base.transaction(() => {
    base.executer(
      `INSERT INTO factures (
         id, entreprise_id, point_de_vente_id, terminal_id, type, statut, numero,
         emise_le, client_id, client_nom, client_ncc,
         total_ht, total_tva, total_ttc, totaux_json,
         version_referentiel, hash_precedent, hash, contenu_qr, facture_origine_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        facture.id,
        facture.entrepriseId,
        facture.pointDeVenteId,
        facture.terminalId,
        facture.type,
        facture.statut,
        facture.numero,
        facture.emiseLe,
        facture.clientId ?? null,
        facture.clientNom,
        facture.clientNcc ?? null,
        facture.totaux.totalHT,
        facture.totaux.totalTVA,
        facture.totaux.totalTTC,
        JSON.stringify(facture.totaux),
        facture.versionReferentielFiscal,
        facture.hashPrecedent,
        facture.hash,
        facture.contenuQR ?? null,
        facture.factureOrigineId ?? null,
      ],
    );

    lignes.forEach((ligne, rang) => {
      base.executer(
        `INSERT INTO lignes_facture (
           id, facture_id, rang, designation, quantite, prix_unitaire_ht,
           code_tva, remise_pourcent, produit_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ligne.id,
          facture.id,
          rang,
          ligne.designation,
          ligne.quantite,
          ligne.prixUnitaireHT,
          ligne.codeTva,
          ligne.remisePourcent ?? 0,
          ligne.produitId ?? null,
        ],
      );
    });

    base.executer('UPDATE plages_numeros SET curseur = ? WHERE id = ?', [
      plageApres.curseur,
      plageApres.id,
    ]);

    empiler(base, {
      id: uuidv7(),
      type: 'CREER_FACTURE',
      entrepriseId: contexte.entrepriseId,
      terminalId: contexte.terminalId,
      hlc: contexte.hlc,
      creeeLe: emiseLe,
      charge: { facture, lignes },
    });

    base.journaliser('FACTURE_EMISE', { id: facture.id, numero: facture.numero });
  });

  return facture;
}

/* ------------------------------------------------------------------ */
/* Consultation                                                        */
/* ------------------------------------------------------------------ */

export interface ResumeFacture {
  id: string;
  numero: string;
  statut: string;
  client_nom: string;
  total_ttc: number;
  emise_le: string;
}

export function dernieresFactures(
  base: BaseLocale,
  entrepriseId: string,
  limite = 10,
): ResumeFacture[] {
  return base.interroger<ResumeFacture>(
    `SELECT id, numero, statut, client_nom, total_ttc, emise_le
       FROM factures
      WHERE entreprise_id = ?
      ORDER BY emise_le DESC
      LIMIT ?`,
    [entrepriseId, limite],
  );
}

export interface TotauxJour {
  nombre: number;
  chiffreAffairesTTC: number;
  tvaCollectee: number;
}

export function totauxDuJour(base: BaseLocale, entrepriseId: string): TotauxJour {
  const debut = new Date();
  debut.setHours(0, 0, 0, 0);

  const lignes = base.interroger<{ n: number; ttc: number | null; tva: number | null }>(
    `SELECT COUNT(*) AS n, SUM(total_ttc) AS ttc, SUM(total_tva) AS tva
       FROM factures
      WHERE entreprise_id = ? AND emise_le >= ? AND type != 'AVOIR'`,
    [entrepriseId, debut.toISOString()],
  );

  const l = lignes[0];
  return {
    nombre: l?.n ?? 0,
    chiffreAffairesTTC: l?.ttc ?? 0,
    tvaCollectee: l?.tva ?? 0,
  };
}
