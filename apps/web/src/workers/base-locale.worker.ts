/**
 * Worker de la base locale.
 *
 * Tout ce qui touche à SQLite vit ici, pour deux raisons :
 *  1. le VFS OPFS `sahpool` n'est utilisable que dans un worker ;
 *  2. le thread principal reste libre — la caisse ne se fige pas pendant une
 *     écriture disque, même sur un appareil lent.
 *
 * Le worker ne reçoit jamais de SQL : il reçoit des intentions métier.
 */

import {
  construireContenuQR,
  HorlogeHLC,
  numerosRestants,
  plageBientotEpuisee,
} from '@fneplus/core';
import { baseLocale } from '@/lib/db/base-locale';
import {
  compterEchecsDefinitifs,
  compterEnAttente,
  recupererCommandesInterrompues,
} from '@/lib/outbox';
import { dernieresFactures, emettreFacture, plageActive, totauxDuJour } from '@/lib/depot/factures';
import { compterClients, enregistrerClient, listerClients } from '@/lib/depot/clients';
import { compterProduits, enregistrerProduit, listerProduits } from '@/lib/depot/produits';
import {
  assurerReserveNumeros,
  libelleAppareilParDefaut,
  ouvrirSessionTerminal,
  referentielsLocaux,
} from '@/lib/onboarding';
import { effacerSession, lireSession, type SessionTerminal } from '@/lib/session-locale';
import { synchroniser } from '@/lib/synchronisation';
import { appelerApi, ErreurApi } from '@/lib/api-client';
import type {
  ChargeClient,
  ChargeProduit,
  ChargeConnexion,
  ChargeEmission,
  ChargeInscription,
  EtatTerminal,
  ReponseTerminal,
  RequeteTerminal,
  ResultatConnexion,
  ResultatEmission,
} from '@/lib/protocole-terminal';

/**
 * Horloge logique du terminal.
 *
 * Créée paresseusement : son identifiant de nœud doit être celui du terminal
 * appairé, qui n'est connu qu'après la connexion.
 */
let horloge: HorlogeHLC | null = null;

function horlogeDe(session: SessionTerminal): HorlogeHLC {
  horloge ??= new HorlogeHLC(session.terminalId);
  return horloge;
}

function sessionRequise(session: SessionTerminal | null): asserts session is SessionTerminal {
  if (!session) {
    const erreur = new Error('Connectez-vous pour utiliser ce terminal.');
    erreur.name = 'SESSION_REQUISE';
    throw erreur;
  }
}

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */

async function etatTerminal(): Promise<EtatTerminal> {
  const base = await baseLocale();
  const session = lireSession(base);

  if (!session) {
    return {
      infos: base.infos,
      session: null,
      factures: [],
      totaux: { nombre: 0, chiffreAffairesTTC: 0, tvaCollectee: 0 },
      enAttente: 0,
      echecs: 0,
      numerosRestants: 0,
      alertePlage: false,
      nombreClients: 0,
      nombreProduits: 0,
    };
  }

  const plage = plageActive(base, session.terminalId);

  return {
    infos: base.infos,
    session: {
      nom: session.nom,
      role: session.role,
      raisonSociale: session.raisonSociale,
      regimeFiscal: session.regimeFiscal,
      terminalId: session.terminalId,
      ...(session.derniereSync ? { derniereSync: session.derniereSync } : {}),
    },
    factures: dernieresFactures(base, session.entrepriseId, 5),
    totaux: totauxDuJour(base, session.entrepriseId),
    enAttente: compterEnAttente(base),
    echecs: compterEchecsDefinitifs(base),
    numerosRestants: plage ? numerosRestants(plage) : 0,
    alertePlage: plage ? plageBientotEpuisee(plage) : true,
    nombreClients: compterClients(base, session.entrepriseId),
    nombreProduits: compterProduits(base, session.entrepriseId),
    ncc: session.ncc,
  };
}

/* ------------------------------------------------------------------ */
/* Traitement des requêtes                                             */
/* ------------------------------------------------------------------ */

async function traiter(requete: RequeteTerminal): Promise<unknown> {
  const base = await baseLocale();

  switch (requete.action) {
    case 'INITIALISER': {
      // Une commande restée « en cours » signale un envoi interrompu
      // (onglet fermé, batterie vide) : on la remet en file au démarrage.
      recupererCommandesInterrompues(base);
      return etatTerminal();
    }

    case 'ETAT':
      return etatTerminal();

    case 'INSCRIRE': {
      const charge = requete.charge as ChargeInscription;
      await appelerApi('/api/v1/entreprises/inscription', {
        methode: 'POST',
        corps: charge,
      });
      // L'inscription n'ouvre pas de session : le numéro doit d'abord être
      // vérifié par code SMS, comme pour toute connexion.
      return { inscrit: true };
    }

    case 'DEMANDER_CODE': {
      const { telephone } = requete.charge as { telephone: string };
      await appelerApi('/api/v1/auth/demander-code', {
        methode: 'POST',
        corps: { telephone },
      });
      return { envoye: true };
    }

    case 'VERIFIER_CODE':
    case 'CONNEXION_PIN': {
      const charge = requete.charge as ChargeConnexion;
      const chemin =
        requete.action === 'VERIFIER_CODE'
          ? '/api/v1/auth/verifier-code'
          : '/api/v1/auth/connexion-pin';
      const corps =
        requete.action === 'VERIFIER_CODE'
          ? { telephone: charge.telephone, code: charge.code }
          : { telephone: charge.telephone, pin: charge.code };

      const reponse = await appelerApi<Parameters<typeof ouvrirSessionTerminal>[1]>(chemin, {
        methode: 'POST',
        corps,
      });

      const ouverture = await ouvrirSessionTerminal(
        base,
        reponse,
        charge.libelleAppareil ?? libelleAppareilParDefaut(),
      );

      // L'horloge est recréée : son nœud est l'identifiant du terminal, qui
      // vient seulement d'être connu.
      horloge = new HorlogeHLC(ouverture.session.terminalId);

      const resultat: ResultatConnexion = {
        etat: await etatTerminal(),
        definirPin: ouverture.definirPin,
      };
      return resultat;
    }

    case 'DEFINIR_PIN': {
      const session = lireSession(base);
      sessionRequise(session);
      const { pin } = requete.charge as { pin: string };
      await appelerApi('/api/v1/auth/definir-pin', {
        methode: 'POST',
        jeton: session.jeton,
        corps: { pin },
      });
      return { defini: true };
    }

    case 'DECONNEXION': {
      effacerSession(base);
      horloge = null;
      return etatTerminal();
    }

    case 'EMETTRE_FACTURE': {
      const session = lireSession(base);
      sessionRequise(session);

      const charge = requete.charge as ChargeEmission;
      const depart = performance.now();

      const facture = await emettreFacture(
        base,
        {
          entrepriseId: session.entrepriseId,
          ncc: session.ncc,
          pointDeVenteId: session.pointDeVenteId,
          terminalId: session.terminalId,
          regimeFiscal: session.regimeFiscal,
          hlc: horlogeDe(session).tick(),
          referentiels: referentielsLocaux(base),
        },
        {
          clientNom: charge.clientNom,
          ...(charge.clientId ? { clientId: charge.clientId } : {}),
          lignes: charge.lignes,
        },
      );

      const qr = construireContenuQR(facture, session.ncc);

      const resultat: ResultatEmission = {
        factureId: facture.id,
        numero: facture.numero,
        totalTTC: facture.totaux.totalTTC,
        emiseLe: facture.emiseLe,
        clientNom: facture.clientNom,
        contenuQR: qr.contenu,
        qrProvisoire: qr.provisoire,
        dureeMs: performance.now() - depart,
      };
      return resultat;
    }

    case 'ENREGISTRER_CLIENT': {
      const session = lireSession(base);
      sessionRequise(session);

      const charge = requete.charge as ChargeClient;
      return enregistrerClient(
        base,
        {
          entrepriseId: session.entrepriseId,
          terminalId: session.terminalId,
          hlc: horlogeDe(session).tick(),
        },
        charge,
      );
    }

    case 'LISTER_CLIENTS': {
      const session = lireSession(base);
      sessionRequise(session);
      const { recherche } = (requete.charge ?? {}) as { recherche?: string };
      return listerClients(base, session.entrepriseId, recherche);
    }

    case 'ENREGISTRER_PRODUIT': {
      const session = lireSession(base);
      sessionRequise(session);

      return enregistrerProduit(
        base,
        {
          entrepriseId: session.entrepriseId,
          terminalId: session.terminalId,
          hlc: horlogeDe(session).tick(),
        },
        requete.charge as ChargeProduit,
      );
    }

    case 'LISTER_PRODUITS': {
      const session = lireSession(base);
      sessionRequise(session);
      const { recherche } = (requete.charge ?? {}) as { recherche?: string };
      return listerProduits(base, session.entrepriseId, recherche);
    }

    case 'SYNCHRONISER': {
      const session = lireSession(base);
      sessionRequise(session);

      const { ignorerDelais } = (requete.charge ?? {}) as { ignorerDelais?: boolean };

      const resultat = await synchroniser(
        base,
        (horodatageServeur) => horlogeDe(session).recaler(horodatageServeur),
        { ignorerDelais: ignorerDelais ?? false },
      );

      // Recharger la réserve tant que le réseau est disponible, plutôt que
      // d'attendre qu'elle soit vide alors que l'appareil sera peut-être hors
      // ligne à ce moment-là.
      if (resultat.statut === 'REUSSIE') {
        try {
          await assurerReserveNumeros(base, session);
        } catch (erreur) {
          console.warn('[worker] rechargement de plage impossible', erreur);
        }
      }

      return { ...resultat, etat: await etatTerminal() };
    }

    default:
      throw new Error(`Action inconnue : ${String(requete.action)}`);
  }
}

self.addEventListener('message', (evenement: MessageEvent<RequeteTerminal>) => {
  const requete = evenement.data;

  void (async () => {
    let reponse: ReponseTerminal;
    try {
      reponse = { id: requete.id, ok: true, resultat: await traiter(requete) };
    } catch (erreur) {
      reponse = {
        id: requete.id,
        ok: false,
        erreur: {
          message: erreur instanceof Error ? erreur.message : String(erreur),
          nom: erreur instanceof Error ? erreur.name : 'Erreur',
          ...(erreur instanceof ErreurApi && erreur.code ? { code: erreur.code } : {}),
        },
      };
    }
    self.postMessage(reponse);
  })();
});
