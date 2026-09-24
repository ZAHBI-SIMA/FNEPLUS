/**
 * Moteur de synchronisation du terminal.
 *
 * Exécuté dans le worker. Le cycle est toujours le même :
 *   1. pousser l'outbox par lots bornés ;
 *   2. appliquer les résultats commande par commande ;
 *   3. récupérer le delta descendant ;
 *   4. recaler l'horloge sur l'heure serveur.
 *
 * Aucune étape n'est indispensable au fonctionnement du terminal : si la
 * synchronisation échoue, l'application continue de facturer normalement et
 * réessaiera. C'est exactement ce que promet le produit.
 */

import {
  deserialiserHLC,
  type Commande,
  type ReponseSynchronisation,
  type ResultatCommande,
} from '@fneplus/core';
import type { BaseLocale } from './db/base-locale';
import { appelerApi, ErreurApi, ErreurReseau } from './api-client';
import {
  appliquerResultats,
  marquerEnCours,
  prochainLot,
  purgerConfirmees,
  relancerImmediatement,
} from './outbox';
import { appliquerDeltaClients } from './depot/clients';
import { appliquerDeltaProduits } from './depot/produits';
import { lireSession, majSession } from './session-locale';

/** Taille d'un lot. Assez petit pour passer sur une connexion lente. */
const TAILLE_LOT = 25;

export interface ResultatSynchronisation {
  statut: 'REUSSIE' | 'HORS_LIGNE' | 'RECONNEXION_REQUISE' | 'PARTIELLE';
  poussees: number;
  refusees: number;
  clientsRecus: number;
  produitsRecus: number;
  message?: string;
}

interface ReponseSyncApi extends ReponseSynchronisation {
  delta: {
    clients: Parameters<typeof appliquerDeltaClients>[2];
    produits: Parameters<typeof appliquerDeltaProduits>[2];
    jusqua: string;
  };
}

export interface OptionsSynchronisation {
  /**
   * Ignore les délais de repli en cours. Posé quand le réseau vient de revenir
   * ou que l'utilisateur a demandé l'envoi lui-même : le délai protégeait le
   * serveur, pas le terminal.
   */
  ignorerDelais?: boolean;
}

export async function synchroniser(
  base: BaseLocale,
  recalerHorloge: (horodatageServeur: number) => void,
  options: OptionsSynchronisation = {},
): Promise<ResultatSynchronisation> {
  const session = lireSession(base);
  if (!session) {
    return {
      statut: 'RECONNEXION_REQUISE',
      poussees: 0,
      refusees: 0,
      clientsRecus: 0,
      produitsRecus: 0,
      message: 'Aucune session ouverte sur cet appareil.',
    };
  }

  if (options.ignorerDelais) relancerImmediatement(base);

  let poussees = 0;
  let refusees = 0;
  let clientsRecus = 0;
  let produitsRecus = 0;

  // Boucle sur les lots : un terminal resté longtemps hors ligne peut avoir des
  // centaines de commandes en attente, mais chaque requête reste courte.
  for (;;) {
    const lot = prochainLot(base, TAILLE_LOT);
    const commandes = lot.map(versCommande);

    // Un lot vide déclenche tout de même un appel : c'est ce qui permet de
    // recevoir le delta descendant sans rien avoir à envoyer.
    let reponse: ReponseSyncApi;
    try {
      marquerEnCours(
        base,
        lot.map((l) => l.id),
      );

      reponse = await appelerApi<ReponseSyncApi>('/api/v1/sync', {
        methode: 'POST',
        jeton: session.jeton,
        corps: {
          terminalId: session.terminalId,
          commandes,
          ...(session.derniereSync ? { depuis: session.derniereSync } : {}),
        },
      });
    } catch (erreur) {
      // Les commandes marquées « en cours » repartiront : elles sont remises en
      // file au prochain démarrage, et l'idempotence serveur couvre le cas où
      // elles auraient déjà été appliquées.
      if (erreur instanceof ErreurApi && erreur.exigeReconnexion) {
        return {
          statut: 'RECONNEXION_REQUISE',
          poussees,
          refusees,
          clientsRecus,
          produitsRecus,
          message: 'Votre session a expiré. Reconnectez-vous pour reprendre l’envoi.',
        };
      }

      return {
        statut: erreur instanceof ErreurReseau ? 'HORS_LIGNE' : 'PARTIELLE',
        poussees,
        refusees,
        clientsRecus,
        produitsRecus,
        message: erreur instanceof Error ? erreur.message : String(erreur),
      };
    }

    appliquerResultats(base, reponse.resultats);
    poussees += reponse.resultats.filter((r: ResultatCommande) => r.accepte).length;
    refusees += reponse.resultats.filter((r: ResultatCommande) => !r.accepte).length;

    if (reponse.delta.clients.length > 0) {
      clientsRecus += appliquerDeltaClients(base, session.entrepriseId, reponse.delta.clients);
    }
    if (reponse.delta.produits.length > 0) {
      produitsRecus += appliquerDeltaProduits(base, session.entrepriseId, reponse.delta.produits);
    }

    recalerHorloge(reponse.horodatageServeur);
    majSession(base, { derniereSync: reponse.delta.jusqua });

    // Dernier lot : plus rien à pousser.
    if (lot.length < TAILLE_LOT) break;
  }

  purgerConfirmees(base);

  return { statut: 'REUSSIE', poussees, refusees, clientsRecus, produitsRecus };
}

function versCommande(ligne: {
  id: string;
  type: string;
  entreprise_id: string;
  terminal_id: string;
  hlc: string;
  creee_le: string;
  charge_json: string;
}): Commande {
  return {
    id: ligne.id,
    type: ligne.type,
    entrepriseId: ligne.entreprise_id,
    terminalId: ligne.terminal_id,
    hlc: deserialiserHLC(ligne.hlc),
    creeeLe: ligne.creee_le,
    charge: JSON.parse(ligne.charge_json),
  } as Commande;
}
