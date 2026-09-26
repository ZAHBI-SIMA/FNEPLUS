'use client';

/**
 * Client du worker de base locale.
 *
 * Fine couche de corrélation requête/réponse. Elle ne contient aucune logique
 * métier : tout ce qui décide vit soit dans `@fneplus/core`, soit dans le
 * worker.
 */

import type {
  ActionTerminal,
  ChargeClient,
  ChargeConnexion,
  ChargeEmission,
  ChargeEncaissementEspeces,
  ChargeInscription,
  ChargePaiementMobile,
  ChargeProduit,
  EtatReglementLocal,
  EtatTerminal,
  ReponseTerminal,
  RequeteTerminal,
  ResultatClients,
  ResultatConnexion,
  ResultatEmission,
  ResultatAnomalies,
  ResultatPaiementMobile,
  ResultatProduits,
  ResultatSynchronisation,
  SituationARF,
} from './protocole-terminal';

export class ErreurTerminal extends Error {
  constructor(
    message: string,
    readonly nom: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = nom;
  }

  get sessionRequise(): boolean {
    return this.nom === 'SESSION_REQUISE';
  }
}

class ClientTerminal {
  private worker: Worker | null = null;
  private compteur = 0;
  private readonly enCours = new Map<
    number,
    { resoudre: (v: unknown) => void; rejeter: (e: Error) => void }
  >();

  private obtenirWorker(): Worker {
    if (this.worker) return this.worker;

    this.worker = new Worker(new URL('../workers/base-locale.worker.ts', import.meta.url), {
      type: 'module',
      name: 'fneplus-base-locale',
    });

    this.worker.addEventListener('message', (evenement: MessageEvent<ReponseTerminal>) => {
      const reponse = evenement.data;
      const attente = this.enCours.get(reponse.id);
      if (!attente) return;
      this.enCours.delete(reponse.id);

      if (reponse.ok) {
        attente.resoudre(reponse.resultat);
      } else {
        attente.rejeter(
          new ErreurTerminal(
            reponse.erreur?.message ?? 'Erreur inconnue du terminal',
            reponse.erreur?.nom ?? 'ErreurTerminal',
            reponse.erreur?.code,
          ),
        );
      }
    });

    this.worker.addEventListener('error', (evenement) => {
      const erreur = new Error(`Le terminal a rencontré une erreur : ${evenement.message}`);
      for (const attente of this.enCours.values()) attente.rejeter(erreur);
      this.enCours.clear();
    });

    return this.worker;
  }

  private appeler<T>(action: ActionTerminal, charge?: unknown): Promise<T> {
    const worker = this.obtenirWorker();
    const id = ++this.compteur;

    return new Promise<T>((resoudre, rejeter) => {
      this.enCours.set(id, { resoudre: resoudre as (v: unknown) => void, rejeter });
      const requete: RequeteTerminal = { id, action, ...(charge !== undefined ? { charge } : {}) };
      worker.postMessage(requete);
    });
  }

  initialiser(): Promise<EtatTerminal> {
    return this.appeler<EtatTerminal>('INITIALISER');
  }

  etat(): Promise<EtatTerminal> {
    return this.appeler<EtatTerminal>('ETAT');
  }

  inscrire(charge: ChargeInscription): Promise<{ inscrit: boolean }> {
    return this.appeler('INSCRIRE', charge);
  }

  demanderCode(telephone: string): Promise<{ envoye: boolean }> {
    return this.appeler('DEMANDER_CODE', { telephone });
  }

  verifierCode(charge: ChargeConnexion): Promise<ResultatConnexion> {
    return this.appeler<ResultatConnexion>('VERIFIER_CODE', charge);
  }

  connexionPin(charge: ChargeConnexion): Promise<ResultatConnexion> {
    return this.appeler<ResultatConnexion>('CONNEXION_PIN', charge);
  }

  definirPin(pin: string): Promise<{ defini: boolean }> {
    return this.appeler('DEFINIR_PIN', { pin });
  }

  deconnexion(): Promise<EtatTerminal> {
    return this.appeler<EtatTerminal>('DECONNEXION');
  }

  emettreFacture(charge: ChargeEmission): Promise<ResultatEmission> {
    return this.appeler<ResultatEmission>('EMETTRE_FACTURE', charge);
  }

  enregistrerClient(charge: ChargeClient): Promise<{ id: string; nom: string }> {
    return this.appeler('ENREGISTRER_CLIENT', charge);
  }

  listerClients(recherche?: string): Promise<ResultatClients> {
    return this.appeler<ResultatClients>('LISTER_CLIENTS', { recherche });
  }

  enregistrerProduit(charge: ChargeProduit): Promise<{ id: string; designation: string }> {
    return this.appeler('ENREGISTRER_PRODUIT', charge);
  }

  listerProduits(recherche?: string): Promise<ResultatProduits> {
    return this.appeler<ResultatProduits>('LISTER_PRODUITS', { recherche });
  }

  listerAnomalies(): Promise<ResultatAnomalies> {
    return this.appeler<ResultatAnomalies>('LISTER_ANOMALIES');
  }

  reessayer(anomalieId: string): Promise<EtatTerminal> {
    return this.appeler<EtatTerminal>('REESSAYER', { anomalieId });
  }

  purgerStockage(): Promise<{ commandesPurgees: number; entreesJournalPurgees: number }> {
    return this.appeler('PURGER_STOCKAGE');
  }

  synchroniser(
    options: { ignorerDelais?: boolean } = {},
  ): Promise<ResultatSynchronisation & { etat: EtatTerminal }> {
    return this.appeler('SYNCHRONISER', options);
  }

  encaisserEspeces(charge: ChargeEncaissementEspeces): Promise<EtatReglementLocal> {
    return this.appeler<EtatReglementLocal>('ENCAISSER_ESPECES', charge);
  }

  etatReglement(factureId: string): Promise<EtatReglementLocal | null> {
    return this.appeler<EtatReglementLocal | null>('ETAT_REGLEMENT', { factureId });
  }

  demanderPaiementMobile(charge: ChargePaiementMobile): Promise<ResultatPaiementMobile> {
    return this.appeler<ResultatPaiementMobile>('DEMANDER_PAIEMENT_MOBILE', charge);
  }

  situationARF(): Promise<SituationARF> {
    return this.appeler<SituationARF>('SITUATION_ARF');
  }
}

let client: ClientTerminal | null = null;

export function terminal(): ClientTerminal {
  client ??= new ClientTerminal();
  return client;
}
