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
import { formaterXOF } from '@fneplus/core';
import { terminal } from '@/lib/client-terminal';
import type { EtatTerminal, ResultatEmission } from '@/lib/protocole-terminal';
import { useEtatReseau } from '@/lib/hooks/useEtatReseau';
import { EcranConnexion } from './EcranConnexion';
import { EcranClients } from './EcranClients';
import { EcranArticles } from './EcranArticles';
import { EcranVente } from './EcranVente';
import { RecuFacture } from './RecuFacture';
import { EcranAVerifier } from './EcranAVerifier';

type Onglet = 'VENTE' | 'ARTICLES' | 'CLIENTS' | 'JOURNAL' | 'A_VERIFIER';

/** La vente est en tête : c'est l'écran ouvert cent fois par jour. */
const ONGLETS: [Onglet, (etat: EtatTerminal) => string][] = [
  ['VENTE', () => 'Vendre'],
  ['ARTICLES', (e) => `Articles${e.nombreProduits > 0 ? ` (${e.nombreProduits})` : ''}`],
  ['CLIENTS', (e) => `Clients${e.nombreClients > 0 ? ` (${e.nombreClients})` : ''}`],
  ['JOURNAL', () => 'Journal'],
  // N'apparaît que s'il y a effectivement quelque chose à vérifier : un onglet
  // toujours vide finit par ne plus être regardé du tout.
  ['A_VERIFIER', (e) => `À vérifier (${e.nombreAnomalies})`],
];

export function TableauDeBordTerminal() {
  const reseau = useEtatReseau();
  const [etat, setEtat] = useState<EtatTerminal | null>(null);
  const [onglet, setOnglet] = useState<Onglet>('VENTE');
  const [recu, setRecu] = useState<ResultatEmission | null>(null);
  const [erreurFatale, setErreurFatale] = useState<string | null>(null);
  const [messageSync, setMessageSync] = useState<string | null>(null);
  const [synchronisation, setSynchronisation] = useState(false);

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

  const deconnecter = useCallback(async () => {
    setEtat(await terminal().deconnexion());
    setOnglet('VENTE');
    setRecu(null);
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

  const session = etat.session;

  const etatBandeau = !reseau.enLigne
    ? 'HORS_LIGNE'
    : synchronisation || etat.enAttente > 0
      ? 'SYNCHRONISATION'
      : 'EN_LIGNE';

  return (
    <>
      {/* Masqué à l'impression : seul le reçu doit sortir sur le papier. */}
      <div className="fne-sans-impression">
        <BandeauReseau
          etat={etatBandeau}
          enAttente={etat.enAttente}
          derniereSyncReussie={session.derniereSync}
        />

        <nav className="fne-onglets" aria-label="Sections">
          {ONGLETS.filter(([cle]) => cle !== 'A_VERIFIER' || etat.nombreAnomalies > 0).map(
            ([cle, libelle]) => (
              <button
                key={cle}
                className={`fne-onglet ${onglet === cle ? 'fne-onglet--actif' : ''}`}
                onClick={() => {
                  setOnglet(cle);
                  setRecu(null);
                }}
                aria-current={onglet === cle ? 'page' : undefined}
              >
                {libelle(etat)}
              </button>
            ),
          )}
        </nav>
      </div>

      <main className="fne-conteneur fne-contenu">
        {etat.nombreAnomalies > 0 && onglet !== 'A_VERIFIER' && !recu ? (
          <button className="fne-rappel-anomalies" onClick={() => setOnglet('A_VERIFIER')}>
            {etat.nombreAnomalies === 1
              ? '1 élément demande votre attention'
              : `${etat.nombreAnomalies} éléments demandent votre attention`}
          </button>
        ) : null}

        {recu ? (
          <RecuFacture
            resultat={recu}
            raisonSociale={session.raisonSociale}
            ncc={etat.ncc ?? ''}
            surFermer={() => setRecu(null)}
          />
        ) : onglet === 'VENTE' ? (
          <EcranVente
            regimeFiscal={session.regimeFiscal}
            surEmission={setRecu}
            surChangement={() => void rafraichir()}
          />
        ) : onglet === 'ARTICLES' ? (
          <EcranArticles surChangement={() => void rafraichir()} />
        ) : onglet === 'CLIENTS' ? (
          <EcranClients surChangement={() => void rafraichir()} />
        ) : onglet === 'A_VERIFIER' ? (
          <EcranAVerifier surChangement={setEtat} />
        ) : (
          <>
            <header>
              <h1 className="fne-titre-page">{session.raisonSociale}</h1>
              <p className="fne-sous-titre">
                {session.nom} · {libelleRegime(session.regimeFiscal)}
              </p>
            </header>

            {etat.infos.avertissement ? (
              <Alerte ton="attente">{etat.infos.avertissement}</Alerte>
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
