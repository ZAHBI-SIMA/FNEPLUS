'use client';

import { useState, type FormEvent } from 'react';
import { Alerte, Bouton, Carte } from '@fneplus/ui';
import { formaterXOF, type CodeTVA } from '@fneplus/core';
import { terminal } from '@/lib/client-terminal';
import type { FactureOrigine, ResultatEmission } from '@/lib/protocole-terminal';

type TypeAjustement = 'AVOIR' | 'RECTIFICATIVE';

interface LigneAjustee {
  designation: string;
  quantiteOrigine: number;
  quantite: number;
  prixUnitaireHT: number;
  codeTva: CodeTVA;
  produitId?: string;
}

const LIBELLES_TVA: Record<CodeTVA, string> = {
  TVA_NORMAL: 'TVA 18 %',
  TVA_REDUIT: 'TVA 9 %',
  EXONERE: 'Exonéré',
  HORS_CHAMP: 'Hors champ',
};

/**
 * Avoirs et factures rectificatives (« 3R » du plan V2).
 *
 * Le modèle de données existait depuis le Sprint 2 (`type`, `factureOrigineId`)
 * mais aucun écran ne permettait de l'utiliser. C'est le point que la DGI et
 * les solutions concurrentes citent comme le plus mal géré ailleurs — d'où
 * l'exigence de retrouver l'original avant de pouvoir le corriger, plutôt que
 * de ressaisir à la main et risquer un écart.
 *
 * Deux natures, une seule mécanique de recherche :
 *  - **Avoir** : crédite tout ou partie des lignes déjà vendues — la quantité
 *    créditée ne peut jamais dépasser ce qui a été vendu.
 *  - **Rectificative** : remplace les lignes d'une facture erronée — le motif
 *    (remplacement, rappel, erreur…) reste un texte libre plutôt qu'un type de
 *    document distinct, faute de spécification DGI confirmée sur ce point.
 */
export function EcranAvoir({
  surEmission,
  surChangement,
}: {
  surEmission: (resultat: ResultatEmission) => void;
  surChangement: () => void;
}) {
  const [numero, setNumero] = useState('');
  const [origine, setOrigine] = useState<FactureOrigine | null>(null);
  const [lignes, setLignes] = useState<LigneAjustee[]>([]);
  const [typeAjustement, setTypeAjustement] = useState<TypeAjustement>('AVOIR');
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [recherche, setRecherche] = useState(false);
  const [occupe, setOccupe] = useState(false);

  const rechercher = (e: FormEvent) => {
    e.preventDefault();
    setErreur(null);
    setOrigine(null);
    setRecherche(true);

    void (async () => {
      try {
        const facture = await terminal().rechercherFacture({ numero });
        setOrigine(facture);
        setLignes(
          facture.lignes.map((l) => ({
            designation: l.designation,
            quantiteOrigine: l.quantite,
            quantite: l.quantite,
            prixUnitaireHT: l.prixUnitaireHT,
            codeTva: l.codeTva,
            ...(l.produitId ? { produitId: l.produitId } : {}),
          })),
        );
      } catch (e2) {
        setErreur(e2 instanceof Error ? e2.message : String(e2));
      } finally {
        setRecherche(false);
      }
    })();
  };

  const majLigne = (index: number, champ: 'quantite' | 'prixUnitaireHT', valeur: number) => {
    setLignes((actuelles) =>
      actuelles.map((l, i) => (i === index ? { ...l, [champ]: valeur } : l)),
    );
  };

  const emettre = (e: FormEvent) => {
    e.preventDefault();
    if (!origine) return;
    setErreur(null);
    setOccupe(true);

    void (async () => {
      try {
        const lignesRetenues = lignes
          .filter((l) => l.quantite > 0)
          .map((l) => ({
            designation: l.designation,
            quantite: l.quantite,
            prixUnitaireHT: l.prixUnitaireHT,
            codeTva: l.codeTva,
            ...(l.produitId ? { produitId: l.produitId } : {}),
          }));

        if (lignesRetenues.length === 0) {
          throw new Error(
            typeAjustement === 'AVOIR'
              ? 'Indiquez au moins une quantité à créditer.'
              : 'La facture rectificative doit conserver au moins une ligne.',
          );
        }
        if (!motif.trim()) {
          throw new Error('Indiquez le motif (remplacement, rappel, erreur constatée…).');
        }

        const resultat = await terminal().emettreFacture({
          clientNom: origine.clientNom,
          ...(origine.clientId ? { clientId: origine.clientId } : {}),
          lignes: lignesRetenues,
          type: typeAjustement,
          factureOrigineId: origine.id,
        });

        surEmission(resultat);
        surChangement();
        setOrigine(null);
        setLignes([]);
        setNumero('');
        setMotif('');
      } catch (e2) {
        setErreur(e2 instanceof Error ? e2.message : String(e2));
      } finally {
        setOccupe(false);
      }
    })();
  };

  const totalRetenu = lignes.reduce(
    (somme, l) => somme + Math.round(l.prixUnitaireHT * l.quantite * 1.18),
    0,
  );

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Avoirs et rectificatives</h1>
        <p className="fne-sous-titre">Retrouvez la facture d’origine avant de la corriger.</p>
      </header>

      <Carte titre="Facture d’origine">
        <form className="fne-formulaire" onSubmit={rechercher}>
          <label className="fne-champ">
            <span>Numéro de facture</span>
            <input
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              placeholder="PDV01-2026-000001"
              required
            />
          </label>
          <Bouton type="submit" disabled={recherche}>
            {recherche ? 'Recherche…' : 'Rechercher'}
          </Bouton>
        </form>
      </Carte>

      {erreur ? <Alerte ton="attente">{erreur}</Alerte> : null}

      {origine ? (
        <>
          <Carte titre={`Facture ${origine.numero}`}>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--fne-texte-faible)' }}>
              {origine.clientNom} · Total {formaterXOF(origine.totalTTC)}
            </p>
          </Carte>

          <Carte titre="Type de document">
            <div className="fne-options">
              <label className="fne-option">
                <input
                  type="radio"
                  name="type"
                  checked={typeAjustement === 'AVOIR'}
                  onChange={() => setTypeAjustement('AVOIR')}
                />
                <span>
                  Avoir
                  <span className="fne-option__aide">
                    Crédite tout ou partie de ce qui a été vendu.
                  </span>
                </span>
              </label>
              <label className="fne-option">
                <input
                  type="radio"
                  name="type"
                  checked={typeAjustement === 'RECTIFICATIVE'}
                  onChange={() => setTypeAjustement('RECTIFICATIVE')}
                />
                <span>
                  Facture rectificative
                  <span className="fne-option__aide">
                    Remplace les lignes d’une facture erronée (remplacement, rappel…).
                  </span>
                </span>
              </label>
            </div>
          </Carte>

          <Carte titre="Lignes">
            <div className="fne-pile">
              {lignes.map((l, index) => (
                <div key={index} className="fne-ligne-panier">
                  <div className="fne-ligne-panier__nom">
                    <strong>{l.designation}</strong>
                    <span className="fne-ligne-panier__detail">
                      Vendu : {l.quantiteOrigine} · {formaterXOF(l.prixUnitaireHT)} HT ·{' '}
                      {LIBELLES_TVA[l.codeTva]}
                    </span>
                  </div>
                  <label className="fne-champ" style={{ maxWidth: '7rem' }}>
                    <span>{typeAjustement === 'AVOIR' ? 'Qté créditée' : 'Nouvelle qté'}</span>
                    <input
                      type="number"
                      min={0}
                      max={typeAjustement === 'AVOIR' ? l.quantiteOrigine : undefined}
                      step="any"
                      value={l.quantite}
                      onChange={(e) => majLigne(index, 'quantite', Number(e.target.value) || 0)}
                    />
                  </label>
                  {typeAjustement === 'RECTIFICATIVE' ? (
                    <label className="fne-champ" style={{ maxWidth: '9rem' }}>
                      <span>Nouveau PU HT</span>
                      <input
                        type="number"
                        min={0}
                        value={l.prixUnitaireHT}
                        onChange={(e) =>
                          majLigne(index, 'prixUnitaireHT', Number(e.target.value) || 0)
                        }
                      />
                    </label>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="fne-totaux">
              <div className="fne-totaux__ligne fne-totaux__ligne--total">
                <span>{typeAjustement === 'AVOIR' ? 'Total à créditer' : 'Nouveau total'}</span>
                <strong className="fne-chiffres">{formaterXOF(totalRetenu)}</strong>
              </div>
            </div>
          </Carte>

          <Carte titre="Motif">
            <label className="fne-champ">
              <span>Raison de {typeAjustement === 'AVOIR' ? 'l’avoir' : 'la rectification'}</span>
              <input
                value={motif}
                onChange={(e) => setMotif(e.target.value)}
                placeholder="Retour marchandise, erreur de prix, remplacement, rappel…"
                required
              />
            </label>
          </Carte>

          <form onSubmit={emettre}>
            <Bouton type="submit" pleineLargeur disabled={occupe}>
              {occupe
                ? 'Émission…'
                : typeAjustement === 'AVOIR'
                  ? `Émettre l’avoir de ${formaterXOF(totalRetenu)}`
                  : 'Émettre la facture rectificative'}
            </Bouton>
          </form>
        </>
      ) : null}
    </>
  );
}
