'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alerte,
  Badge,
  BandeauReseau,
  Bouton,
  Carte,
  libelleStatutFacture,
  LigneInfo,
  tonPourStatutFacture,
} from '@fneplus/ui';
import { formaterXOF, type LigneFacture } from '@fneplus/core';
import { terminal } from '@/lib/client-terminal';
import type { EtatTerminal } from '@/lib/protocole-terminal';
import { useEtatReseau } from '@/lib/hooks/useEtatReseau';
import { EcranConnexion } from './EcranConnexion';
import { EcranClients } from './EcranClients';

/** Panier de démonstration, en attendant l'écran de saisie du Sprint 2. */
const PANIER_DEMO: Omit<LigneFacture, 'id'>[] = [
  {
    designation: 'Sac de riz parfumé 25 kg',
    quantite: 1,
    prixUnitaireHT: 18_500,
    codeTva: 'TVA_NORMAL',
  },
  { designation: 'Bidon d’huile 5 L', quantite: 2, prixUnitaireHT: 6_200, codeTva: 'TVA_NORMAL' },
  {
    designation: 'Lait en poudre 400 g',
    quantite: 3,
    prixUnitaireHT: 2_400,
    codeTva: 'TVA_REDUIT',
  },
];

type Onglet = 'CAISSE' | 'CLIENTS';

export function TableauDeBordTerminal() {
  const reseau = useEtatReseau();
  const [etat, setEtat] = useState<EtatTerminal | null>(null);
  const [onglet, setOnglet] = useState<Onglet>('CAISSE');
  const [erreurFatale, setErreurFatale] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [messageSync, setMessageSync] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [synchronisation, setSynchronisation] = useState(false);
  const [derniereEmission, setDerniereEmission] = useState<{
    numero: string;
    dureeMs: number;
  } | null>(null);

  const rafraichir = useCallback(async () => {
    setEtat(await terminal().etat());
  }, []);

  useEffect(() => {
    let annule = false;
    terminal()
      .initialiser()
      .then((e) => {
        if (!annule) setEtat(e);
      })
      .catch((e: unknown) => {
        if (!annule) setErreurFatale(e instanceof Error ? e.message : String(e));
      });
    return () => {
      annule = true;
    };
  }, []);

  /**
   * Verrou de synchronisation.
   *
   * Une ref et non un état : le verrou doit être lu et posé dans le même tour
   * d'exécution, alors qu'un `setState` n'est visible qu'au rendu suivant. Sans
   * lui, le déclenchement automatique relançait une synchronisation à chaque
   * changement d'état — donc en boucle, puisque chaque synchronisation change
   * l'état.
   */
  const syncEnCours = useRef(false);

  const lancerSync = useCallback(async (silencieuse = false) => {
    if (syncEnCours.current) return;
    syncEnCours.current = true;

    setSynchronisation(true);
    if (!silencieuse) setMessageSync(null);

    try {
      // Envoi demandé explicitement ou réseau revenu : dans les deux cas, les
      // délais de repli accumulés hors ligne n'ont plus de raison d'être.
      const resultat = await terminal().synchroniser({ ignorerDelais: true });
      setEtat(resultat.etat);

      if (silencieuse) return;

      switch (resultat.statut) {
        case 'REUSSIE':
          setMessageSync(
            resultat.poussees > 0
              ? `${resultat.poussees} élément${resultat.poussees > 1 ? 's' : ''} transmis.`
              : 'Tout était déjà à jour.',
          );
          break;
        case 'HORS_LIGNE':
          setMessageSync('Pas de réseau. L’envoi reprendra automatiquement.');
          break;
        case 'RECONNEXION_REQUISE':
          setMessageSync(resultat.message ?? 'Reconnectez-vous pour reprendre l’envoi.');
          break;
        default:
          setMessageSync(resultat.message ?? 'Envoi interrompu, il reprendra automatiquement.');
      }
    } catch (e) {
      if (!silencieuse) setMessageSync(e instanceof Error ? e.message : String(e));
    } finally {
      syncEnCours.current = false;
      setSynchronisation(false);
    }
  }, []);

  // Le retour du réseau déclenche une synchronisation silencieuse : le
  // commerçant n'a rien à faire, ses factures partent d'elles-mêmes.
  //
  // Les dépendances sont volontairement réduites à la présence d'une session et
  // à l'état du réseau. Y ajouter `enAttente` relancerait une synchronisation à
  // chaque changement de compteur, c'est-à-dire en continu.
  const connecte = Boolean(etat?.session);
  useEffect(() => {
    if (!connecte || !reseau.enLigne) return;
    void lancerSync(true);
  }, [connecte, reseau.enLigne, lancerSync]);

  // Relance périodique tant qu'il reste des éléments en attente. Un intervalle
  // large suffit : le retour du réseau et l'action manuelle couvrent les cas
  // pressants, et marteler le serveur ne ferait pas partir les factures plus vite.
  const resteAEnvoyer = (etat?.enAttente ?? 0) > 0;
  useEffect(() => {
    if (!connecte || !reseau.enLigne || !resteAEnvoyer) return;
    const minuteur = setInterval(() => void lancerSync(true), 60_000);
    return () => clearInterval(minuteur);
  }, [connecte, reseau.enLigne, resteAEnvoyer, lancerSync]);

  // Le service worker signale un réveil en arrière-plan (Background Sync).
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const ecouteur = (evenement: MessageEvent) => {
      if ((evenement.data as { type?: string })?.type === 'SYNCHRONISER') void lancerSync(true);
    };
    navigator.serviceWorker.addEventListener('message', ecouteur);
    return () => navigator.serviceWorker.removeEventListener('message', ecouteur);
  }, [lancerSync]);

  const emettre = useCallback(async () => {
    setOccupe(true);
    setErreur(null);
    try {
      const resultat = await terminal().emettreFacture({
        clientNom: 'Client comptant',
        lignes: PANIER_DEMO,
      });
      setDerniereEmission({ numero: resultat.numero, dureeMs: resultat.dureeMs });
      await rafraichir();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }, [rafraichir]);

  const deconnecter = useCallback(async () => {
    setEtat(await terminal().deconnexion());
    setOnglet('CAISSE');
  }, []);

  if (erreurFatale) {
    return (
      <main className="fne-conteneur fne-contenu">
        <Alerte ton="erreur">
          <div>
            <strong>Le terminal n’a pas pu démarrer.</strong>
            <p style={{ margin: '0.5rem 0 0' }}>{erreurFatale}</p>
          </div>
        </Alerte>
      </main>
    );
  }

  if (!etat) {
    return (
      <main className="fne-conteneur fne-contenu">
        <p>Ouverture du terminal…</p>
      </main>
    );
  }

  if (!etat.session) {
    return (
      <EcranConnexion surConnexion={setEtat} avertissementStockage={etat.infos.avertissement} />
    );
  }

  const etatBandeau = !reseau.enLigne
    ? 'HORS_LIGNE'
    : synchronisation || etat.enAttente > 0
      ? 'SYNCHRONISATION'
      : 'EN_LIGNE';

  return (
    <>
      <BandeauReseau
        etat={etatBandeau}
        enAttente={etat.enAttente}
        derniereSyncReussie={etat.session.derniereSync}
      />

      <nav className="fne-onglets" aria-label="Sections">
        <button
          className={`fne-onglet ${onglet === 'CAISSE' ? 'fne-onglet--actif' : ''}`}
          onClick={() => setOnglet('CAISSE')}
          aria-current={onglet === 'CAISSE' ? 'page' : undefined}
        >
          Caisse
        </button>
        <button
          className={`fne-onglet ${onglet === 'CLIENTS' ? 'fne-onglet--actif' : ''}`}
          onClick={() => setOnglet('CLIENTS')}
          aria-current={onglet === 'CLIENTS' ? 'page' : undefined}
        >
          Clients{etat.nombreClients > 0 ? ` (${etat.nombreClients})` : ''}
        </button>
      </nav>

      <main className="fne-conteneur fne-contenu">
        {onglet === 'CLIENTS' ? (
          <EcranClients surChangement={() => void rafraichir()} />
        ) : (
          <>
            <header>
              <h1 className="fne-titre-page">{etat.session.raisonSociale}</h1>
              <p className="fne-sous-titre">
                {etat.session.nom} · {libelleRegime(etat.session.regimeFiscal)}
              </p>
            </header>

            {etat.infos.avertissement ? (
              <Alerte ton="erreur">{etat.infos.avertissement}</Alerte>
            ) : null}

            {etat.alertePlage ? (
              <Alerte ton="attente">
                Réserve de numéros bientôt épuisée ({etat.numerosRestants} restants). Connectez-vous
                quelques secondes pour en recharger une.
              </Alerte>
            ) : null}

            {messageSync ? <Alerte ton="info">{messageSync}</Alerte> : null}

            <div className="fne-grille-stats">
              <Carte titre="Factures du jour">
                <p className="fne-stat__valeur">{etat.totaux.nombre}</p>
              </Carte>
              <Carte titre="Encaissé TTC">
                <p className="fne-stat__valeur">
                  {formaterXOF(etat.totaux.chiffreAffairesTTC, { avecDevise: false })}{' '}
                  <span className="fne-stat__unite">F CFA</span>
                </p>
              </Carte>
              <Carte titre="TVA collectée">
                <p className="fne-stat__valeur">
                  {formaterXOF(etat.totaux.tvaCollectee, { avecDevise: false })}{' '}
                  <span className="fne-stat__unite">F CFA</span>
                </p>
              </Carte>
            </div>

            <Carte titre="État du terminal">
              <LigneInfo
                libelle="Stockage des factures"
                valeur={
                  etat.infos.mode === 'OPFS' ? (
                    <Badge ton="succes">Persistant sur l’appareil</Badge>
                  ) : (
                    <Badge ton="erreur">Mémoire seule</Badge>
                  )
                }
              />
              <LigneInfo
                libelle="Conservation garantie"
                valeur={
                  etat.infos.stockagePersistant ? (
                    <Badge ton="succes">Oui</Badge>
                  ) : (
                    <Badge ton="attente">Non garantie</Badge>
                  )
                }
              />
              <LigneInfo libelle="Numéros en réserve" valeur={etat.numerosRestants} numerique />
              <LigneInfo libelle="En attente d’envoi" valeur={etat.enAttente} numerique />
              {etat.echecs > 0 ? (
                <LigneInfo
                  libelle="À corriger"
                  valeur={<Badge ton="erreur">{etat.echecs}</Badge>}
                />
              ) : null}
              <LigneInfo
                libelle="Qualité réseau"
                valeur={reseau.enLigne ? (reseau.qualite ?? 'connecté') : 'aucune'}
              />
            </Carte>

            <Carte titre="Démonstration">
              <p style={{ marginTop: 0, fontSize: '0.875rem' }}>
                Coupez le réseau, puis émettez une facture : elle est calculée, numérotée, chaînée
                et mise en file sans aucun appel serveur.
              </p>
              <div className="fne-actions">
                <Bouton onClick={() => void emettre()} disabled={occupe} pleineLargeur>
                  {occupe ? 'Émission…' : 'Émettre une facture de démonstration'}
                </Bouton>
              </div>
              {derniereEmission ? (
                <p
                  style={{ marginBottom: 0, fontSize: '0.875rem', color: 'var(--fne-succes-600)' }}
                >
                  Facture <span className="fne-chiffres">{derniereEmission.numero}</span> émise en{' '}
                  <strong>{derniereEmission.dureeMs.toFixed(0)} ms</strong>.
                </p>
              ) : null}
              {erreur ? <Alerte ton="erreur">{erreur}</Alerte> : null}
            </Carte>

            <Carte titre="Dernières factures">
              {etat.factures.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--fne-texte-faible)' }}>
                  Aucune facture émise sur ce terminal.
                </p>
              ) : (
                <div className="fne-pile">
                  {etat.factures.map((f) => (
                    <div key={f.id} className="fne-facture">
                      <span className="fne-facture__numero">{f.numero}</span>
                      <span className="fne-facture__montant">{formaterXOF(f.total_ttc)}</span>
                      <span className="fne-facture__client">{f.client_nom}</span>
                      <span className="fne-facture__statut">
                        <Badge ton={tonPourStatutFacture(f.statut)}>
                          {libelleStatutFacture(f.statut)}
                        </Badge>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Carte>

            <div className="fne-actions">
              <Bouton
                variante="secondaire"
                pleineLargeur
                onClick={() => void lancerSync()}
                disabled={synchronisation}
              >
                {synchronisation ? 'Envoi en cours…' : 'Envoyer maintenant'}
              </Bouton>
              <Bouton variante="discret" onClick={() => void deconnecter()}>
                Se déconnecter
              </Bouton>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function libelleRegime(regime: string): string {
  const libelles: Record<string, string> = {
    ENTREPRENANT: 'Régime de l’entreprenant',
    MICROENTREPRISE: 'Microentreprise',
    REEL_SIMPLIFIE: 'Réel simplifié',
    REEL_NORMAL: 'Réel normal',
  };
  return libelles[regime] ?? regime;
}
