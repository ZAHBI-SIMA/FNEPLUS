'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alerte, Badge, Bouton, Carte, LigneInfo } from '@fneplus/ui';
import { formaterXOF } from '@fneplus/core';
import { terminal } from '@/lib/client-terminal';
import type { ResultatBoutiques } from '@/lib/protocole-terminal';

/**
 * Boutiques (V2 — élargissement des comptes, chantier « multi-boutiques »).
 *
 * Vue consolidée, pas locale : la base d'un terminal ne connaît que sa propre
 * caisse, jamais celle d'une autre boutique. Ce que cet écran affiche vient
 * donc du serveur, à travers tous les terminaux de chaque boutique — c'est
 * précisément ce que « consolidé » veut dire.
 *
 * Droits différenciés : un caissier rattaché à une boutique précise ne voit
 * que celle-ci ; un propriétaire ou un comptable voient tout. Le formulaire
 * de création n'est proposé qu'au propriétaire — ouvrir une boutique engage
 * l'entreprise (numérotation, transmission DGI), pas une décision de caisse.
 */
export function EcranBoutiques({ peutCreer }: { peutCreer: boolean }) {
  const [boutiques, setBoutiques] = useState<ResultatBoutiques | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [saisie, setSaisie] = useState({ libelle: '', adresse: '' });
  const [occupe, setOccupe] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      setBoutiques(await terminal().resumeBoutiques());
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  const creer = (e: FormEvent) => {
    e.preventDefault();
    setOccupe(true);
    setErreur(null);

    void (async () => {
      try {
        const boutique = await terminal().creerBoutique({
          libelle: saisie.libelle,
          ...(saisie.adresse ? { adresse: saisie.adresse } : {}),
        });
        setConfirmation(`${boutique.libelle} (${boutique.code}) a été créée.`);
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

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Boutiques</h1>
        <p className="fne-sous-titre">
          {peutCreer
            ? 'Activité du jour, toutes boutiques confondues.'
            : 'Activité du jour de votre boutique.'}
        </p>
      </header>

      {erreur ? <Alerte ton="attente">{erreur}</Alerte> : null}
      {confirmation ? <Alerte ton="info">{confirmation}</Alerte> : null}

      {boutiques === null ? (
        <p>Chargement…</p>
      ) : (
        <div className="fne-pile">
          {boutiques.map((b) => (
            <Carte key={b.id} titre={`${b.libelle} · ${b.code}`}>
              <LigneInfo libelle="Factures du jour" valeur={b.facturesDuJour} numerique />
              <LigneInfo
                libelle="Encaissé TTC du jour"
                valeur={formaterXOF(b.caDuJourTTC)}
                numerique
              />
            </Carte>
          ))}
        </div>
      )}

      {peutCreer ? (
        formulaireOuvert ? (
          <Carte titre="Nouvelle boutique">
            <form className="fne-formulaire" onSubmit={creer}>
              <label className="fne-champ">
                <span>Nom de la boutique</span>
                <input
                  value={saisie.libelle}
                  onChange={(e) => setSaisie((s) => ({ ...s, libelle: e.target.value }))}
                  placeholder="Boutique Marcory"
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
                  {occupe ? 'Création…' : 'Créer la boutique'}
                </Bouton>
                <Bouton variante="discret" type="button" onClick={() => setFormulaireOuvert(false)}>
                  Annuler
                </Bouton>
              </div>
            </form>
          </Carte>
        ) : (
          <Bouton variante="secondaire" onClick={() => setFormulaireOuvert(true)}>
            Ouvrir une nouvelle boutique
          </Bouton>
        )
      ) : (
        <Badge ton="neutre">Vous êtes rattaché à une seule boutique.</Badge>
      )}
    </>
  );
}
