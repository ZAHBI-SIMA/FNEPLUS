/**
 * Session du terminal, conservée en base locale.
 *
 * Le jeton est stocké dans SQLite (OPFS) plutôt que dans `localStorage` :
 *  - le worker, qui porte toute la synchronisation, y accède directement, sans
 *    aller-retour avec le thread principal ;
 *  - il survit dans le même cycle de vie que les factures qu'il sert à
 *    transmettre — un jeton perdu alors que des factures attendent créerait une
 *    situation ingérable pour le commerçant ;
 *  - `localStorage` peut être vidé indépendamment d'OPFS par le navigateur.
 *
 * Un cookie `httpOnly` serait plus résistant au vol par script, mais il serait
 * illisible depuis le worker et ne fonctionnerait pas hors ligne. Le compromis
 * retenu est assumé : l'application ne charge aucun script tiers, ce qui réduit
 * fortement la surface d'injection. À réévaluer au Sprint 6 avec l'audit.
 */

import type { DepotLocal } from './db/depot-local';

export interface SessionTerminal {
  jeton: string;
  entrepriseId: string;
  utilisateurId: string;
  role: 'PROPRIETAIRE' | 'CAISSIER' | 'COMPTABLE';
  nom: string;
  raisonSociale: string;
  /** NCC de l'entreprise : il figure dans le QR de chaque facture. */
  ncc: string;
  regimeFiscal: 'ENTREPRENANT' | 'MICROENTREPRISE' | 'REEL_SIMPLIFIE' | 'REEL_NORMAL';
  pointDeVenteId: string;
  terminalId: string;
  /** Horodatage du dernier delta reçu, pour ne demander que les changements. */
  derniereSync?: string;
}

const CLE = 'session';

export function lireSession(base: DepotLocal): SessionTerminal | null {
  const lignes = base.interroger<{ valeur: string }>('SELECT valeur FROM meta WHERE cle = ?', [
    CLE,
  ]);
  const brut = lignes[0]?.valeur;
  if (!brut) return null;

  try {
    return JSON.parse(brut) as SessionTerminal;
  } catch {
    return null;
  }
}

export function ecrireSession(base: DepotLocal, session: SessionTerminal): void {
  base.executer(
    `INSERT INTO meta (cle, valeur) VALUES (?, ?)
     ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`,
    [CLE, JSON.stringify(session)],
  );
}

export function majSession(base: DepotLocal, champs: Partial<SessionTerminal>): SessionTerminal {
  const actuelle = lireSession(base);
  if (!actuelle) throw new Error('Aucune session ouverte sur ce terminal.');
  const fusionnee = { ...actuelle, ...champs };
  ecrireSession(base, fusionnee);
  return fusionnee;
}

/**
 * Efface la session.
 *
 * Les données métier ne sont PAS effacées : des factures peuvent encore attendre
 * d'être transmises, et les perdre à la déconnexion serait une faute grave. Elles
 * repartiront à la prochaine connexion du même compte.
 */
export function effacerSession(base: DepotLocal): void {
  base.executer('DELETE FROM meta WHERE cle = ?', [CLE]);
  base.journaliser('SESSION_FERMEE');
}

/**
 * Empreinte stable de l'appareil.
 *
 * Générée une fois et conservée localement. Elle permet au serveur de
 * reconnaître un terminal qui se réinstalle et de lui rendre son identité, au
 * lieu de lui allouer une nouvelle réserve de numéros et de laisser un trou de
 * séquence inexpliqué.
 */
export function empreinteAppareil(base: DepotLocal): string {
  const lignes = base.interroger<{ valeur: string }>('SELECT valeur FROM meta WHERE cle = ?', [
    'empreinte_appareil',
  ]);
  const existante = lignes[0]?.valeur;
  if (existante) return existante;

  const empreinte = crypto.randomUUID();
  base.executer('INSERT INTO meta (cle, valeur) VALUES (?, ?)', ['empreinte_appareil', empreinte]);
  return empreinte;
}
