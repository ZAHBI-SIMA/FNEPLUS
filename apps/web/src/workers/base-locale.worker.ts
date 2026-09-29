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
import {
  dernieresFactures,
  emettreFacture,
  obtenirFactureParNumero,
  plageActive,
  totauxDuJour,
} from '@/lib/depot/factures';
import { compterClients, enregistrerClient, listerClients } from '@/lib/depot/clients';
import { compterProduits, enregistrerProduit, listerProduits } from '@/lib/depot/produits';
import {
  compterAnomalies,
  etatStockage,
  listerAnomalies,
  purgerStockage,
  reessayerCommande,
} from '@/lib/depot/a-verifier';
import {
  appliquerReglementServeur,
  enregistrerPaiementEspeces,
  etatReglementLocal,
  type SaisiePaiementEspeces,
} from '@/lib/depot/paiements';
import {
  assurerReserveNumeros,
  libelleAppareilParDefaut,
  ouvrirSessionTerminal,
  referentielsLocaux,
  synchroniserPointsDeVenteAutorises,
} from '@/lib/onboarding';
import { effacerSession, lireSession, type SessionTerminal } from '@/lib/session-locale';
import { synchroniser } from '@/lib/synchronisation';
import { appelerApi, ErreurApi } from '@/lib/api-client';
import type {
  ChargeAssurerReserve,
  ChargeAutoriserTerminalPdv,
  ChargeClient,
  ChargeCreerBoutique,
  ChargeCreerEtablissement,
  ChargeListerPdvAutorisesTerminal,
  ChargeProduit,
  ChargeConnexion,
  ChargeEmission,
  ChargePaiementMobile,
  ChargeInscription,
  ChargeRechercherFacture,
  Etablissement,
  EtatTerminal,
  FactureOrigine,
  KpisEntreprise,
  ReponseTerminal,
  RequeteTerminal,
  ResultatBoutiques,
  ResultatConnexion,
  ResultatCreerBoutique,
  ResultatEmission,
  ResultatEtablissements,
  ResultatPaiementMobile,
  ResultatTerminaux,
  PointDeVenteTerminal,
  SituationARF,
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
      nombreAnomalies: 0,
    };
  }

  const plage = plageActive(base, session.terminalId, session.pointDeVenteId);

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
    nombreAnomalies: compterAnomalies(base, session.terminalId),
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

      const { facture, lignesCalculees } = await emettreFacture(
        base,
        {
          entrepriseId: session.entrepriseId,
          ncc: session.ncc,
          // Sélecteur rapide en caisse : une vente peut être facturée au nom
          // d'un autre point de vente que le principal, s'il a été autorisé
          // pour ce terminal (voir POINTS_DE_VENTE_TERMINAL).
          pointDeVenteId: charge.pointDeVenteId ?? session.pointDeVenteId,
          terminalId: session.terminalId,
          regimeFiscal: session.regimeFiscal,
          hlc: horlogeDe(session).tick(),
          referentiels: referentielsLocaux(base),
        },
        {
          clientNom: charge.clientNom,
          ...(charge.clientId ? { clientId: charge.clientId } : {}),
          lignes: charge.lignes,
          ...(charge.type ? { type: charge.type } : {}),
          ...(charge.factureOrigineId ? { factureOrigineId: charge.factureOrigineId } : {}),
        },
      );

      const qr = construireContenuQR(facture, session.ncc);

      // Résolu depuis la base plutôt que repris du message reçu : la facture
      // d'origine fait foi, pas ce que l'écran d'avoir pensait avoir trouvé.
      const numeroOrigine = facture.factureOrigineId
        ? base.interroger<{ numero: string }>(`SELECT numero FROM factures WHERE id = ?`, [
            facture.factureOrigineId,
          ])[0]?.numero
        : undefined;

      const resultat: ResultatEmission = {
        factureId: facture.id,
        numero: facture.numero,
        type: facture.type,
        totalTTC: facture.totaux.totalTTC,
        totalTVA: facture.totaux.totalTVA,
        emiseLe: facture.emiseLe,
        clientNom: facture.clientNom,
        ...(charge.clientAdresse ? { clientAdresse: charge.clientAdresse } : {}),
        ...(numeroOrigine ? { numeroOrigine } : {}),
        contenuQR: qr.contenu,
        qrProvisoire: qr.provisoire,
        dureeMs: performance.now() - depart,
        // PU TTC dérivé du montant de ligne, pas ressaisi : le tableau du reçu
        // doit rester la conséquence du calcul fiscal, jamais une deuxième
        // source de vérité sur le prix.
        lignes: lignesCalculees.map((l) => ({
          designation: l.designation,
          quantite: l.quantite,
          prixUnitaireTTC: l.quantite > 0 ? Math.round(l.montantTTC / l.quantite) : 0,
          montantTTC: l.montantTTC,
        })),
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

    case 'LISTER_ANOMALIES': {
      const session = lireSession(base);
      sessionRequise(session);
      return listerAnomalies(base, session.terminalId);
    }

    case 'REESSAYER': {
      const session = lireSession(base);
      sessionRequise(session);
      const { anomalieId } = requete.charge as { anomalieId: string };
      reessayerCommande(base, anomalieId);
      return etatTerminal();
    }

    case 'PURGER_STOCKAGE': {
      const session = lireSession(base);
      sessionRequise(session);
      const purge = purgerStockage(base);
      return { ...purge, stockage: etatStockage(base) };
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
      // ligne à ce moment-là. Même occasion pour rafraîchir les points de
      // vente que ce terminal est autorisé à facturer (sélecteur rapide en
      // caisse) : une autorisation accordée par le propriétaire après la
      // connexion doit apparaître sans que le caissier doive se reconnecter.
      if (resultat.statut === 'REUSSIE') {
        try {
          await assurerReserveNumeros(base, session);
        } catch (erreur) {
          console.warn('[worker] rechargement de plage impossible', erreur);
        }
        try {
          await synchroniserPointsDeVenteAutorises(base, session);
        } catch (erreur) {
          console.warn('[worker] synchronisation des points de vente autorisés impossible', erreur);
        }
      }

      return { ...resultat, etat: await etatTerminal() };
    }

    case 'ENCAISSER_ESPECES': {
      const session = lireSession(base);
      sessionRequise(session);

      return enregistrerPaiementEspeces(
        base,
        {
          entrepriseId: session.entrepriseId,
          terminalId: session.terminalId,
          hlc: horlogeDe(session).tick(),
        },
        requete.charge as SaisiePaiementEspeces,
      );
    }

    case 'ETAT_REGLEMENT': {
      const { factureId } = requete.charge as { factureId: string };

      // Un règlement mobile money se constate côté serveur (le webhook du
      // prestataire ne touche jamais l'appareil) : quand le réseau est là, le
      // serveur fait foi et son résultat est répercuté en local. Hors ligne,
      // ou si l'appel échoue, l'état local — toujours à jour pour un
      // règlement en espèces — reste la meilleure réponse disponible.
      const session = lireSession(base);
      if (session) {
        try {
          const distant = await appelerApi<{
            factureId: string;
            totalTTC: number;
            montantRegle: number;
            regleeLe?: string;
          } | null>(`/api/v1/paiements/factures/${factureId}`, { jeton: session.jeton });
          if (distant) return appliquerReglementServeur(base, distant);
        } catch {
          // Réseau indisponible ou serveur en erreur : on retombe sur le local.
        }
      }

      return etatReglementLocal(base, factureId);
    }

    case 'DEMANDER_PAIEMENT_MOBILE': {
      // Exige le réseau : cette opération appelle directement l'API, qui elle-
      // même sollicite un prestataire externe. Il n'y a rien à mettre en file
      // hors ligne — une demande de paiement n'a de sens qu'immédiate, et le
      // client doit pouvoir régler dans la minute qui suit.
      const session = lireSession(base);
      sessionRequise(session);

      // La facture vient peut-être d'être émise hors ligne et n'a pas encore
      // atteint le serveur (la synchronisation de fond tourne au plus toutes
      // les 60 s) : sans ce coup de pouce, l'API répondrait « facture
      // introuvable » alors que le caissier vient tout juste de l'émettre.
      // Le réseau est de toute façon requis pour la suite de cette opération.
      await synchroniser(
        base,
        (horodatageServeur) => horlogeDe(session).recaler(horodatageServeur),
        {
          ignorerDelais: true,
        },
      );

      const charge = requete.charge as ChargePaiementMobile;
      const resultat = await appelerApi<ResultatPaiementMobile>('/api/v1/paiements', {
        methode: 'POST',
        jeton: session.jeton,
        corps: {
          factureId: charge.factureId,
          moyen: charge.moyen,
          montant: charge.montant,
          ...(charge.telephone ? { telephone: charge.telephone } : {}),
        },
      });
      return resultat;
    }

    case 'SITUATION_ARF': {
      const session = lireSession(base);
      sessionRequise(session);
      return appelerApi<SituationARF>('/api/v1/arf/situation', { jeton: session.jeton });
    }

    case 'KPIS_ENTREPRISE': {
      const session = lireSession(base);
      sessionRequise(session);
      return appelerApi<KpisEntreprise>('/api/v1/kpis/entreprise', { jeton: session.jeton });
    }

    case 'RESUME_BOUTIQUES': {
      const session = lireSession(base);
      sessionRequise(session);
      return appelerApi<ResultatBoutiques>('/api/v1/entreprises/points-de-vente/resume', {
        jeton: session.jeton,
      });
    }

    case 'CREER_BOUTIQUE': {
      const session = lireSession(base);
      sessionRequise(session);
      const charge = requete.charge as ChargeCreerBoutique;
      return appelerApi<ResultatCreerBoutique>('/api/v1/entreprises/points-de-vente', {
        methode: 'POST',
        jeton: session.jeton,
        corps: charge,
      });
    }

    case 'RECHERCHER_FACTURE': {
      const session = lireSession(base);
      sessionRequise(session);
      const { numero } = requete.charge as ChargeRechercherFacture;
      const facture = obtenirFactureParNumero(base, session.entrepriseId, numero);
      if (!facture) {
        throw new Error(`Aucune facture ne porte le numéro « ${numero} ».`);
      }
      const resultat: FactureOrigine = {
        id: facture.id,
        numero: facture.numero,
        type: facture.type,
        clientId: facture.clientId,
        clientNom: facture.clientNom,
        clientNcc: facture.clientNcc,
        totalTTC: facture.totalTTC,
        lignes: facture.lignes,
      };
      return resultat;
    }

    case 'ASSURER_RESERVE': {
      const session = lireSession(base);
      sessionRequise(session);
      const { pointDeVenteId } = requete.charge as ChargeAssurerReserve;
      await assurerReserveNumeros(base, session, pointDeVenteId);
      return { ok: true };
    }

    case 'LISTER_ETABLISSEMENTS': {
      const session = lireSession(base);
      sessionRequise(session);
      return appelerApi<ResultatEtablissements>('/api/v1/entreprises/etablissements', {
        jeton: session.jeton,
      });
    }

    case 'CREER_ETABLISSEMENT': {
      const session = lireSession(base);
      sessionRequise(session);
      const charge = requete.charge as ChargeCreerEtablissement;
      return appelerApi<Etablissement>('/api/v1/entreprises/etablissements', {
        methode: 'POST',
        jeton: session.jeton,
        corps: charge,
      });
    }

    case 'LISTER_TERMINAUX': {
      const session = lireSession(base);
      sessionRequise(session);
      return appelerApi<ResultatTerminaux>('/api/v1/terminaux', { jeton: session.jeton });
    }

    case 'AUTORISER_TERMINAL_PDV': {
      const session = lireSession(base);
      sessionRequise(session);
      const { terminalId, pointDeVenteId } = requete.charge as ChargeAutoriserTerminalPdv;
      await appelerApi(`/api/v1/terminaux/${terminalId}/points-de-vente-autorises`, {
        methode: 'POST',
        jeton: session.jeton,
        corps: { pointDeVenteId },
      });
      return { ok: true };
    }

    case 'PDV_AUTORISES_TERMINAL': {
      const session = lireSession(base);
      sessionRequise(session);
      const { terminalId } = requete.charge as ChargeListerPdvAutorisesTerminal;
      return appelerApi<PointDeVenteTerminal[]>(
        `/api/v1/terminaux/${terminalId}/points-de-vente-autorises`,
        { jeton: session.jeton },
      );
    }

    case 'POINTS_DE_VENTE_TERMINAL': {
      const session = lireSession(base);
      sessionRequise(session);
      const lignes = base.interroger<{ id: string; libelle: string; code: string }>(
        `SELECT id, libelle, code FROM points_de_vente
          WHERE id = ?
             OR id IN (SELECT point_de_vente_id FROM terminaux_points_de_vente WHERE terminal_id = ?)
          ORDER BY code`,
        [session.pointDeVenteId, session.terminalId],
      );
      const resultat: PointDeVenteTerminal[] = lignes.map((l) => ({
        ...l,
        principal: l.id === session.pointDeVenteId,
      }));
      return resultat;
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
