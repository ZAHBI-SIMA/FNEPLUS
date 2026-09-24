'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alerte, Bouton, Carte } from '@fneplus/ui';
import {
  calculerFacture,
  formaterXOF,
  type CodeTVA,
  type LigneFacture,
  type RegimeFiscal,
} from '@fneplus/core';
import { terminal } from '@/lib/client-terminal';
import type { LigneProduit } from '@/lib/depot/produits';
import type { LigneClient } from '@/lib/depot/clients';
import type { ResultatEmission } from '@/lib/protocole-terminal';

/**
 * Écran de vente.
 *
 * Le parcours vise les 30 secondes annoncées par le cahier des charges : on
 * tape un article, on l'ajoute, on encaisse. Le client est facultatif — une
 * vente au comptant n'a pas à attendre qu'on saisisse une fiche — et les totaux
 * se recalculent à chaque frappe, en local, avec le même moteur que celui qui
 * fera foi à l'émission.
 */

const TVA_LIBELLES: Record<CodeTVA, string> = {
  TVA_NORMAL: 'TVA 18 %',
  TVA_REDUIT: 'TVA 9 %',
  EXONERE: 'Exonéré',
  HORS_CHAMP: 'Hors champ',
};

interface LignePanier extends Omit<LigneFacture, 'id'> {
  cle: string;
}

export function EcranVente({
  regimeFiscal,
  surEmission,
  surChangement,
}: {
  regimeFiscal: RegimeFiscal;
  surEmission: (resultat: ResultatEmission) => void;
  surChangement: () => void;
}) {
  const [panier, setPanier] = useState<LignePanier[]>([]);
  const [produits, setProduits] = useState<LigneProduit[]>([]);
  const [clients, setClients] = useState<LigneClient[]>([]);
  const [recherche, setRecherche] = useState('');
  const [clientChoisi, setClientChoisi] = useState<LigneClient | null>(null);
  const [saisieLibre, setSaisieLibre] = useState({
    designation: '',
    prix: '',
    codeTva: 'TVA_NORMAL' as CodeTVA,
  });
  const [libreOuvert, setLibreOuvert] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    void terminal()
      .listerProduits(recherche)
      .then(setProduits)
      .catch(() => {});
  }, [recherche]);

  useEffect(() => {
    void terminal()
      .listerClients()
      .then(setClients)
      .catch(() => {});
  }, []);

  /**
   * Totaux recalculés à chaque changement du panier.
   *
   * Le calcul tourne en local avec `@fneplus/core` — le même code que celui
   * appliqué à l'émission puis revérifié par le serveur. Le montant affiché au
   * client avant validation est donc exactement celui qui sera facturé.
   */
  const totaux = useMemo(() => {
    if (panier.length === 0) return null;
    try {
      return calculerFacture(
        panier.map((l, i) => ({ ...l, id: `apercu-${i}` })),
        { dateEmission: new Date().toISOString(), regimeFiscal },
      );
    } catch {
      return null;
    }
  }, [panier, regimeFiscal]);

  const ajouterProduit = useCallback((produit: LigneProduit) => {
    setPanier((actuel) => {
      // Un article déjà au panier incrémente sa quantité : le caissier scanne
      // ou tape trois fois le même article sans se retrouver avec trois lignes.
      const existant = actuel.findIndex((l) => l.produitId === produit.id);
      if (existant >= 0) {
        const copie = [...actuel];
        copie[existant] = { ...copie[existant]!, quantite: copie[existant]!.quantite + 1 };
        return copie;
      }
      return [
        ...actuel,
        {
          cle: `${produit.id}-${Date.now()}`,
          designation: produit.designation,
          quantite: 1,
          prixUnitaireHT: produit.prix_unitaire_ht,
          codeTva: produit.code_tva,
          produitId: produit.id,
        },
      ];
    });
  }, []);

  const ajouterLibre = (e: FormEvent) => {
    e.preventDefault();
    const prix = Number(saisieLibre.prix);
    if (!saisieLibre.designation.trim() || !Number.isInteger(prix) || prix < 0) {
      setErreur('Indiquez une désignation et un prix entier en francs CFA.');
      return;
    }
    setPanier((a) => [
      ...a,
      {
        cle: `libre-${Date.now()}`,
        designation: saisieLibre.designation.trim(),
        quantite: 1,
        prixUnitaireHT: prix,
        codeTva: saisieLibre.codeTva,
      },
    ]);
    setSaisieLibre({ designation: '', prix: '', codeTva: 'TVA_NORMAL' });
    setLibreOuvert(false);
    setErreur(null);
  };

  const changerQuantite = useCallback((cle: string, delta: number) => {
    setPanier((actuel) =>
      actuel
        .map((l) => (l.cle === cle ? { ...l, quantite: l.quantite + delta } : l))
        .filter((l) => l.quantite > 0),
    );
  }, []);

  const encaisser = useCallback(async () => {
    setOccupe(true);
    setErreur(null);
    try {
      const resultat = await terminal().emettreFacture({
        clientNom: clientChoisi?.nom ?? 'Client comptant',
        ...(clientChoisi ? { clientId: clientChoisi.id } : {}),
        lignes: panier.map(({ cle: _cle, ...ligne }) => ligne),
      });
      setPanier([]);
      setClientChoisi(null);
      surEmission(resultat);
      surChangement();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }, [panier, clientChoisi, surEmission, surChangement]);

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Nouvelle vente</h1>
        <p className="fne-sous-titre">
          {clientChoisi ? clientChoisi.nom : 'Client comptant'} ·{' '}
          {panier.length === 0
            ? 'panier vide'
            : `${panier.length} ligne${panier.length > 1 ? 's' : ''}`}
        </p>
      </header>

      {erreur ? <Alerte ton="erreur">{erreur}</Alerte> : null}

      {/* Le panier d'abord : c'est ce que le caissier regarde en priorité. */}
      {panier.length > 0 ? (
        <Carte titre="Panier">
          <div className="fne-pile">
            {panier.map((ligne) => (
              <div key={ligne.cle} className="fne-ligne-panier">
                <span className="fne-ligne-panier__nom">
                  {ligne.designation}
                  <span className="fne-ligne-panier__detail">
                    {formaterXOF(ligne.prixUnitaireHT)} · {TVA_LIBELLES[ligne.codeTva]}
                  </span>
                </span>
                <span className="fne-quantite">
                  <button
                    type="button"
                    className="fne-quantite__bouton"
                    onClick={() => changerQuantite(ligne.cle, -1)}
                    aria-label={`Retirer un ${ligne.designation}`}
                  >
                    −
                  </button>
                  <span className="fne-quantite__valeur">{ligne.quantite}</span>
                  <button
                    type="button"
                    className="fne-quantite__bouton"
                    onClick={() => changerQuantite(ligne.cle, 1)}
                    aria-label={`Ajouter un ${ligne.designation}`}
                  >
                    +
                  </button>
                </span>
              </div>
            ))}
          </div>

          {totaux ? (
            <div className="fne-totaux">
              <div className="fne-totaux__ligne">
                <span>Total HT</span>
                <span className="fne-chiffres">{formaterXOF(totaux.totaux.totalHT)}</span>
              </div>
              {totaux.totaux.ventilation
                .filter((v) => v.montantTVA > 0)
                .map((v) => (
                  <div key={v.codeTva} className="fne-totaux__ligne fne-totaux__ligne--detail">
                    <span>TVA {v.taux} %</span>
                    <span className="fne-chiffres">{formaterXOF(v.montantTVA)}</span>
                  </div>
                ))}
              {totaux.exonereParRegime ? (
                <div className="fne-totaux__ligne fne-totaux__ligne--detail">
                  <span>TVA non applicable à votre régime</span>
                  <span>—</span>
                </div>
              ) : null}
              <div className="fne-totaux__ligne fne-totaux__ligne--total">
                <span>À payer</span>
                <span className="fne-chiffres">{formaterXOF(totaux.totaux.totalTTC)}</span>
              </div>
            </div>
          ) : null}

          <div className="fne-actions">
            <Bouton pleineLargeur onClick={() => void encaisser()} disabled={occupe}>
              {occupe ? 'Émission…' : `Encaisser ${formaterXOF(totaux?.totaux.totalTTC ?? 0)}`}
            </Bouton>
            <Bouton variante="discret" onClick={() => setPanier([])}>
              Vider le panier
            </Bouton>
          </div>
        </Carte>
      ) : null}

      <Carte titre="Articles">
        <label className="fne-champ">
          <span className="fne-visuellement-cache">Rechercher un article</span>
          <input
            type="search"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher un article"
          />
        </label>

        {produits.length === 0 ? (
          <p style={{ margin: '0 0 1rem', color: 'var(--fne-texte-faible)' }}>
            {recherche
              ? 'Aucun article ne correspond.'
              : 'Aucun article enregistré. Ajoutez-en depuis l’onglet Articles, ou saisissez une ligne libre.'}
          </p>
        ) : (
          <div className="fne-grille-articles">
            {produits.map((p) => (
              <button
                key={p.id}
                type="button"
                className="fne-article"
                onClick={() => ajouterProduit(p)}
              >
                <span className="fne-article__nom">{p.designation}</span>
                <span className="fne-article__prix fne-chiffres">
                  {formaterXOF(p.prix_unitaire_ht)}
                </span>
              </button>
            ))}
          </div>
        )}

        {libreOuvert ? (
          <form className="fne-formulaire" onSubmit={ajouterLibre}>
            <label className="fne-champ">
              <span>Désignation</span>
              <input
                required
                autoFocus
                value={saisieLibre.designation}
                onChange={(e) => setSaisieLibre({ ...saisieLibre, designation: e.target.value })}
                placeholder="Article non catalogué"
              />
            </label>
            <label className="fne-champ">
              <span>Prix unitaire HT (F CFA)</span>
              <input
                required
                inputMode="numeric"
                value={saisieLibre.prix}
                onChange={(e) =>
                  setSaisieLibre({ ...saisieLibre, prix: e.target.value.replace(/\D/g, '') })
                }
              />
            </label>
            <label className="fne-champ">
              <span>Taxation</span>
              <select
                value={saisieLibre.codeTva}
                onChange={(e) =>
                  setSaisieLibre({ ...saisieLibre, codeTva: e.target.value as CodeTVA })
                }
              >
                {(Object.keys(TVA_LIBELLES) as CodeTVA[]).map((c) => (
                  <option key={c} value={c}>
                    {TVA_LIBELLES[c]}
                  </option>
                ))}
              </select>
            </label>
            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur>
                Ajouter au panier
              </Bouton>
              <Bouton variante="discret" onClick={() => setLibreOuvert(false)}>
                Annuler
              </Bouton>
            </div>
          </form>
        ) : (
          <Bouton variante="secondaire" pleineLargeur onClick={() => setLibreOuvert(true)}>
            Saisir une ligne libre
          </Bouton>
        )}
      </Carte>

      <Carte titre="Client">
        <div className="fne-actions">
          <Bouton
            variante={clientChoisi ? 'secondaire' : 'principal'}
            onClick={() => setClientChoisi(null)}
          >
            Client comptant
          </Bouton>
        </div>
        {clients.length > 0 ? (
          <div className="fne-grille-articles" style={{ marginTop: 'var(--fne-esp-3)' }}>
            {clients.slice(0, 8).map((c) => (
              <button
                key={c.id}
                type="button"
                className={`fne-article ${clientChoisi?.id === c.id ? 'fne-article--choisi' : ''}`}
                onClick={() => setClientChoisi(c)}
              >
                <span className="fne-article__nom">{c.nom}</span>
                {c.ncc ? <span className="fne-article__prix">NCC {c.ncc}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </Carte>
    </>
  );
}
