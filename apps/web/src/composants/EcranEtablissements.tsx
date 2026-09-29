'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alerte, Bouton, Carte, LigneInfo } from '@fneplus/ui';
import { terminal } from '@/lib/client-terminal';
import type {
  Etablissement,
  PointDeVenteTerminal,
  ResultatBoutiques,
  TerminalResume,
} from '@/lib/protocole-terminal';

/**
 * Établissements (V2 — hiérarchie établissements → points de vente).
 *
 * Un établissement est un site physique déclaré à l'administration fiscale ;
 * un point de vente (« boutique », voir l'écran du même nom) est une caisse
 * ou un comptoir à l'intérieur. Cet écran ajoute le niveau au-dessus, et le
 * sélecteur rapide en caisse : autoriser un terminal à facturer aussi au nom
 * d'un autre point de vente que le sien.
 *
 * Réservé au propriétaire : ouvrir un site ou étendre ce qu'un appareil peut
 * facturer engage l'entreprise (numérotation, transmission DGI), comme pour
 * une boutique.
 */
export function EcranEtablissements() {
  const [etablissements, setEtablissements] = useState<Etablissement[] | null>(null);
  const [boutiques, setBoutiques] = useState<ResultatBoutiques>([]);
  const [terminaux, setTerminaux] = useState<TerminalResume[]>([]);
  const [autorisations, setAutorisations] = useState<Record<string, PointDeVenteTerminal[]>>({});
  const [erreur, setErreur] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [saisie, setSaisie] = useState({ libelle: '', adresse: '' });
  const [occupe, setOccupe] = useState(false);

  const [terminalChoisi, setTerminalChoisi] = useState<string>('');
  const [pdvAAutoriser, setPdvAAutoriser] = useState<string>('');
  const [autorisationEnCours, setAutorisationEnCours] = useState(false);

  const charger = useCallback(async () => {
    try {
      const [etbs, btqs, tms] = await Promise.all([
        terminal().listerEtablissements(),
        terminal().resumeBoutiques(),
        terminal().listerTerminaux(),
      ]);
      setEtablissements(etbs);
      setBoutiques(btqs);
      setTerminaux(tms);

      const paires = await Promise.all(
        tms.map(async (t) => [t.id, await terminal().pdvAutorisesTerminal({ terminalId: t.id })] as const),
      );
      setAutorisations(Object.fromEntries(paires));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  const creerEtablissement = (e: FormEvent) => {
    e.preventDefault();
    setOccupe(true);
    setErreur(null);

    void (async () => {
      try {
        const etb = await terminal().creerEtablissement({
          libelle: saisie.libelle,
          ...(saisie.adresse ? { adresse: saisie.adresse } : {}),
        });
        setConfirmation(`${etb.libelle} (${etb.code}) a été créé.`);
        setSaisie({ libelle: '', adresse: '' });
        setFormulaireOuvert(false);
        await charger();
      } catch (e2) {
        setErreur(e2 instanceof Error ? e2.message : String(e2));
      } finally {
        setOccupe(false);
      }
    })();
  };

  const autoriser = (e: FormEvent) => {
    e.preventDefault();
    if (!terminalChoisi || !pdvAAutoriser) return;
    setAutorisationEnCours(true);
    setErreur(null);

    void (async () => {
      try {
        await terminal().autoriserTerminalPdv({
          terminalId: terminalChoisi,
          pointDeVenteId: pdvAAutoriser,
        });
        setConfirmation('Point de vente autorisé pour cet appareil.');
        setPdvAAutoriser('');
        await charger();
      } catch (e2) {
        setErreur(e2 instanceof Error ? e2.message : String(e2));
      } finally {
        setAutorisationEnCours(false);
      }
    })();
  };

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Établissements</h1>
        <p className="fne-sous-titre">Sites déclarés, et sélecteur rapide en caisse.</p>
      </header>

      {erreur ? <Alerte ton="attente">{erreur}</Alerte> : null}
      {confirmation ? <Alerte ton="info">{confirmation}</Alerte> : null}

      {etablissements === null ? (
        <p>Chargement…</p>
      ) : (
        <div className="fne-pile">
          {etablissements.map((etb) => (
            <Carte key={etb.id} titre={`${etb.libelle} · ${etb.code}`}>
              {etb.adresse ? <LigneInfo libelle="Adresse" valeur={etb.adresse} /> : null}
            </Carte>
          ))}
        </div>
      )}

      {formulaireOuvert ? (
        <Carte titre="Nouvel établissement">
          <form className="fne-formulaire" onSubmit={creerEtablissement}>
            <label className="fne-champ">
              <span>Nom du site</span>
              <input
                value={saisie.libelle}
                onChange={(e) => setSaisie((s) => ({ ...s, libelle: e.target.value }))}
                placeholder="Site de Yopougon"
                required
              />
            </label>
            <label className="fne-champ">
              <span>Adresse</span>
              <input
                value={saisie.adresse}
                onChange={(e) => setSaisie((s) => ({ ...s, adresse: e.target.value }))}
                placeholder="Facultatif"
              />
            </label>
            <div className="fne-actions">
              <Bouton type="submit" disabled={occupe}>
                {occupe ? 'Création…' : "Créer l'établissement"}
              </Bouton>
              <Bouton variante="discret" type="button" onClick={() => setFormulaireOuvert(false)}>
                Annuler
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : (
        <Bouton variante="secondaire" onClick={() => setFormulaireOuvert(true)}>
          Déclarer un nouvel établissement
        </Bouton>
      )}

      <Carte titre="Sélecteur rapide en caisse">
        <p style={{ margin: '0 0 1rem', color: 'var(--fne-texte-faible)' }}>
          Autorisez un appareil à facturer aussi au nom d'un autre point de vente que le sien.
          Chaque point de vente autorisé obtient sa propre réserve de numéros : le point de vente
          principal de l'appareil n'est jamais affecté.
        </p>

        {terminaux.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--fne-texte-faible)' }}>Aucun appareil appairé.</p>
        ) : (
          <div className="fne-pile">
            {terminaux.map((t) => (
              <div key={t.id} className="fne-ligne-panier">
                <span className="fne-ligne-panier__nom">
                  {t.libelle}
                  <span className="fne-ligne-panier__detail">
                    Principal : {t.pointDeVenteCode}
                    {(autorisations[t.id] ?? [])
                      .filter((p) => !p.principal)
                      .map((p) => ` · ${p.code}`)
                      .join('')}
                    {t.revoque ? ' · révoqué' : ''}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}

        <form className="fne-formulaire" onSubmit={autoriser} style={{ marginTop: 'var(--fne-esp-4)' }}>
          <label className="fne-champ">
            <span>Appareil</span>
            <select
              value={terminalChoisi}
              onChange={(e) => {
                setTerminalChoisi(e.target.value);
                // Change d'appareil : la liste « déjà autorisé » ci-dessous ne
                // vaut que pour l'appareil choisi, une sélection reprise de
                // l'appareil précédent n'aurait plus de sens.
                setPdvAAutoriser('');
              }}
              required
            >
              <option value="" disabled>
                Choisir un appareil
              </option>
              {terminaux
                .filter((t) => !t.revoque)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.libelle} (principal : {t.pointDeVenteCode})
                  </option>
                ))}
            </select>
          </label>
          <label className="fne-champ">
            <span>Point de vente supplémentaire</span>
            <select
              value={pdvAAutoriser}
              onChange={(e) => setPdvAAutoriser(e.target.value)}
              disabled={!terminalChoisi}
              required
            >
              <option value="" disabled>
                Choisir un point de vente
              </option>
              {boutiques
                .filter((b) => {
                  const dejaAutorise = (autorisations[terminalChoisi] ?? []).some((p) => p.id === b.id);
                  return !dejaAutorise;
                })
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.libelle} ({b.code})
                  </option>
                ))}
            </select>
          </label>
          <Bouton type="submit" disabled={autorisationEnCours || !terminalChoisi || !pdvAAutoriser}>
            {autorisationEnCours ? 'Autorisation…' : 'Autoriser'}
          </Bouton>
        </form>
      </Carte>
    </>
  );
}
