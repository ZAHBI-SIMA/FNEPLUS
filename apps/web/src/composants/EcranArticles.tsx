'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alerte, Bouton, Carte } from '@fneplus/ui';
import { formaterXOF, type CodeTVA } from '@fneplus/core';
import { terminal } from '@/lib/client-terminal';
import type { LigneProduit } from '@/lib/depot/produits';

/**
 * Catalogue d'articles.
 *
 * Comme le répertoire clients, il fonctionne intégralement hors ligne. Le prix
 * est saisi hors taxes et en francs entiers : le franc CFA n'a pas de
 * subdivision, et laisser saisir des décimales ne produirait que des arrondis
 * inattendus sur la facture.
 */

const TVA_OPTIONS: { valeur: CodeTVA; libelle: string }[] = [
  { valeur: 'TVA_NORMAL', libelle: 'TVA 18 % (taux normal)' },
  { valeur: 'TVA_REDUIT', libelle: 'TVA 9 % (taux réduit)' },
  { valeur: 'EXONERE', libelle: 'Exonéré de TVA' },
  { valeur: 'HORS_CHAMP', libelle: 'Hors champ d’application' },
];

export function EcranArticles({ surChangement }: { surChangement: () => void }) {
  const [produits, setProduits] = useState<LigneProduit[]>([]);
  const [recherche, setRecherche] = useState('');
  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [saisie, setSaisie] = useState({
    designation: '',
    prix: '',
    codeTva: 'TVA_NORMAL' as CodeTVA,
    reference: '',
  });
  const [erreur, setErreur] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const charger = useCallback(async (filtre: string) => {
    try {
      setProduits(await terminal().listerProduits(filtre));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void charger(recherche);
  }, [charger, recherche]);

  const enregistrer = (e: FormEvent) => {
    e.preventDefault();
    setOccupe(true);
    setErreur(null);

    void (async () => {
      try {
        const produit = await terminal().enregistrerProduit({
          designation: saisie.designation,
          prixUnitaireHT: Number(saisie.prix),
          codeTva: saisie.codeTva,
          ...(saisie.reference ? { reference: saisie.reference } : {}),
        });
        setConfirmation(`${produit.designation} a été ajouté au catalogue.`);
        setSaisie({ designation: '', prix: '', codeTva: 'TVA_NORMAL', reference: '' });
        setFormulaireOuvert(false);
        await charger(recherche);
        surChangement();
      } catch (e) {
        setErreur(e instanceof Error ? e.message : String(e));
      } finally {
        setOccupe(false);
      }
    })();
  };

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Articles</h1>
        <p className="fne-sous-titre">
          Votre catalogue : choisir un article évite de ressaisir prix et taxation à chaque vente.
        </p>
      </header>

      {erreur ? <Alerte ton="erreur">{erreur}</Alerte> : null}
      {confirmation ? <Alerte ton="info">{confirmation}</Alerte> : null}

      {formulaireOuvert ? (
        <Carte titre="Nouvel article">
          <form className="fne-formulaire" onSubmit={enregistrer}>
            <label className="fne-champ">
              <span>Désignation</span>
              <input
                required
                autoFocus
                value={saisie.designation}
                onChange={(e) => setSaisie({ ...saisie, designation: e.target.value })}
                placeholder="Sac de riz parfumé 25 kg"
              />
            </label>
            <label className="fne-champ">
              <span>Prix unitaire hors taxes (F CFA)</span>
              <input
                required
                inputMode="numeric"
                value={saisie.prix}
                onChange={(e) => setSaisie({ ...saisie, prix: e.target.value.replace(/\D/g, '') })}
                placeholder="18500"
              />
            </label>
            <label className="fne-champ">
              <span>Taxation</span>
              <select
                value={saisie.codeTva}
                onChange={(e) => setSaisie({ ...saisie, codeTva: e.target.value as CodeTVA })}
              >
                {TVA_OPTIONS.map((o) => (
                  <option key={o.valeur} value={o.valeur}>
                    {o.libelle}
                  </option>
                ))}
              </select>
            </label>
            <label className="fne-champ">
              <span>Référence</span>
              <input
                value={saisie.reference}
                onChange={(e) => setSaisie({ ...saisie, reference: e.target.value })}
                placeholder="Facultatif"
              />
            </label>
            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur disabled={occupe}>
                {occupe ? 'Enregistrement…' : 'Enregistrer'}
              </Bouton>
              <Bouton variante="discret" onClick={() => setFormulaireOuvert(false)}>
                Annuler
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : (
        <div className="fne-actions">
          <Bouton pleineLargeur onClick={() => setFormulaireOuvert(true)}>
            Ajouter un article
          </Bouton>
        </div>
      )}

      <Carte titre={`Catalogue (${produits.length})`}>
        <label className="fne-champ">
          <span className="fne-visuellement-cache">Rechercher un article</span>
          <input
            type="search"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher par désignation ou référence"
          />
        </label>

        {produits.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--fne-texte-faible)' }}>
            {recherche ? 'Aucun article ne correspond.' : 'Aucun article au catalogue.'}
          </p>
        ) : (
          <div className="fne-pile">
            {produits.map((p) => (
              <div key={p.id} className="fne-facture">
                <span>{p.designation}</span>
                <span className="fne-facture__montant">{formaterXOF(p.prix_unitaire_ht)}</span>
                <span className="fne-facture__client">
                  {TVA_OPTIONS.find((o) => o.valeur === p.code_tva)?.libelle ?? p.code_tva}
                  {p.reference ? ` · ${p.reference}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Carte>
    </>
  );
}
