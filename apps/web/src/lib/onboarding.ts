/**
 * Ouverture d'une session sur un terminal.
 *
 * Après une connexion réussie, trois choses doivent se passer avant que le
 * commerçant puisse facturer hors ligne :
 *   1. l'appareil est appairé comme terminal de l'entreprise ;
 *   2. il reçoit une réserve de numéros qui n'appartient qu'à lui ;
 *   3. il met en cache le référentiel fiscal en vigueur.
 *
 * Ces trois étapes sont les seules du produit qui exigent réellement le réseau.
 * C'est pour cela qu'elles sont regroupées ici, faites une fois, et que tout le
 * reste s'en passe.
 */

import { uuidv7, type VersionReferentielFiscal } from '@fneplus/core';
import type { BaseLocale } from './db/base-locale';
import { appelerApi } from './api-client';
import { ecrireSession, empreinteAppareil, type SessionTerminal } from './session-locale';

interface ReponseConnexionApi {
  jeton: string;
  session: {
    utilisateurId: string;
    entrepriseId: string;
    role: 'PROPRIETAIRE' | 'CAISSIER' | 'COMPTABLE';
    nom: string;
  };
  definirPin: boolean;
}

interface EntrepriseApi {
  id: string;
  raisonSociale: string;
  regimeFiscal: SessionTerminal['regimeFiscal'];
  pointsDeVente: { id: string; libelle: string; code: string }[];
}

interface PlageApi {
  id: string;
  prefixe: string;
  debut: number;
  fin: number;
  longueurCompteur: number;
  allouceLe: string;
}

export interface ResultatOuverture {
  session: SessionTerminal;
  definirPin: boolean;
}

/**
 * Établit la session complète à partir d'une réponse d'authentification.
 * Appelée aussi bien après une connexion par code SMS que par code PIN.
 */
export async function ouvrirSessionTerminal(
  base: BaseLocale,
  reponse: ReponseConnexionApi,
  libelleAppareil: string,
): Promise<ResultatOuverture> {
  const { jeton } = reponse;

  const entreprise = await appelerApi<EntrepriseApi>('/api/v1/entreprises/moi', { jeton });
  const pointDeVente = entreprise.pointsDeVente[0];
  if (!pointDeVente) {
    throw new Error('Cette entreprise n’a aucun point de vente configuré.');
  }

  // L'empreinte permet au serveur de reconnaître l'appareil après une
  // réinstallation et de lui rendre son terminal, plutôt que d'en créer un
  // nouveau et de consommer une plage pour rien.
  const terminal = await appelerApi<{ terminalId: string }>('/api/v1/terminaux/appairage', {
    methode: 'POST',
    jeton,
    corps: {
      pointDeVenteId: pointDeVente.id,
      libelle: libelleAppareil,
      empreinte: empreinteAppareil(base),
    },
  });

  const session: SessionTerminal = {
    jeton,
    entrepriseId: reponse.session.entrepriseId,
    utilisateurId: reponse.session.utilisateurId,
    role: reponse.session.role,
    nom: reponse.session.nom,
    raisonSociale: entreprise.raisonSociale,
    regimeFiscal: entreprise.regimeFiscal,
    pointDeVenteId: pointDeVente.id,
    terminalId: terminal.terminalId,
  };

  base.transaction(() => {
    ecrireSession(base, session);
    base.executer(
      `INSERT INTO entreprises (id, ncc, raison_sociale, regime_fiscal, adresse, telephone, maj_le)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         raison_sociale = excluded.raison_sociale, regime_fiscal = excluded.regime_fiscal,
         maj_le = excluded.maj_le`,
      [
        session.entrepriseId,
        '',
        entreprise.raisonSociale,
        entreprise.regimeFiscal,
        '',
        '',
        new Date().toISOString(),
      ],
    );
    base.executer(
      `INSERT INTO points_de_vente (id, entreprise_id, libelle, code)
       VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET libelle = excluded.libelle`,
      [pointDeVente.id, session.entrepriseId, pointDeVente.libelle, pointDeVente.code],
    );
    base.executer(
      `INSERT INTO terminaux (id, entreprise_id, point_de_vente_id, libelle)
       VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET libelle = excluded.libelle`,
      [session.terminalId, session.entrepriseId, pointDeVente.id, libelleAppareil],
    );
  });

  await assurerReserveNumeros(base, session);
  await mettreEnCacheReferentiels(base);

  return { session, definirPin: reponse.definirPin };
}

/**
 * Garantit que le terminal dispose d'une réserve de numéros utilisable.
 *
 * Appelée à la connexion, puis à chaque fois que la réserve approche de
 * l'épuisement. C'est la seule opération qui doit impérativement être faite
 * pendant que le réseau est là.
 */
export async function assurerReserveNumeros(
  base: BaseLocale,
  session: SessionTerminal,
): Promise<void> {
  const [restantes] = base.interroger<{ n: number }>(
    `SELECT COALESCE(SUM(fin - curseur + 1), 0) AS n FROM plages_numeros
      WHERE terminal_id = ? AND cloturee_le IS NULL AND curseur <= fin`,
    [session.terminalId],
  );

  if ((restantes?.n ?? 0) > 100) return;

  const plages = await appelerApi<PlageApi[]>(`/api/v1/terminaux/${session.terminalId}/plages`, {
    jeton: session.jeton,
  });

  // Plages déjà connues du serveur mais absentes en local : cas d'une
  // réinstallation. On les reprend avec leur curseur au début, puis la
  // contrainte d'unicité sur le numéro de facture protège d'un doublon.
  const connues = new Set(
    base
      .interroger<{ id: string }>('SELECT id FROM plages_numeros WHERE terminal_id = ?', [
        session.terminalId,
      ])
      .map((l) => l.id),
  );

  const manquantes = plages.filter((p) => !connues.has(p.id));

  if (manquantes.length === 0) {
    const nouvelle = await appelerApi<PlageApi>(`/api/v1/terminaux/${session.terminalId}/plages`, {
      methode: 'POST',
      jeton: session.jeton,
    });
    manquantes.push(nouvelle);
  }

  base.transaction(() => {
    for (const plage of manquantes) {
      base.executer(
        `INSERT INTO plages_numeros (
           id, entreprise_id, point_de_vente_id, terminal_id, prefixe,
           debut, fin, curseur, longueur_compteur, allouee_le
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [
          plage.id,
          session.entrepriseId,
          session.pointDeVenteId,
          session.terminalId,
          plage.prefixe,
          plage.debut,
          plage.fin,
          plage.debut,
          plage.longueurCompteur,
          plage.allouceLe,
        ],
      );
    }
    base.journaliser('PLAGES_RECHARGEES', { nombre: manquantes.length });
  });
}

/**
 * Met en cache le référentiel fiscal.
 *
 * C'est ce cache qui permet de calculer une TVA juste hors ligne. Sans lui, le
 * terminal retomberait sur les versions embarquées dans le bundle, qui peuvent
 * dater du dernier déploiement.
 */
export async function mettreEnCacheReferentiels(base: BaseLocale): Promise<number> {
  const versions = await appelerApi<VersionReferentielFiscal[]>('/api/v1/referentiels/fiscaux');

  base.transaction(() => {
    for (const version of versions) {
      base.executer(
        `INSERT INTO referentiels_fiscaux (version, date_effet, date_fin, contenu_json, recu_le)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(version) DO UPDATE SET
           date_fin = excluded.date_fin, contenu_json = excluded.contenu_json,
           recu_le = excluded.recu_le`,
        [
          version.version,
          version.dateEffet,
          version.dateFin,
          JSON.stringify(version),
          new Date().toISOString(),
        ],
      );
    }
  });

  return versions.length;
}

/** Référentiels en cache local, pour le calcul hors ligne. */
export function referentielsLocaux(base: BaseLocale): VersionReferentielFiscal[] {
  return base
    .interroger<{ contenu_json: string }>(
      'SELECT contenu_json FROM referentiels_fiscaux ORDER BY date_effet ASC',
    )
    .map((l) => JSON.parse(l.contenu_json) as VersionReferentielFiscal);
}

/** Nom par défaut donné à l'appareil au premier appairage. */
export function libelleAppareilParDefaut(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Android/i.test(ua)) return 'Téléphone Android';
  if (/iPhone|iPad/i.test(ua)) return 'Appareil iOS';
  return `Appareil ${uuidv7().slice(0, 4)}`;
}
