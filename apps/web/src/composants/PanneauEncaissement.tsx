'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alerte, Badge, Bouton, Carte, LigneInfo } from '@fneplus/ui';
import { formaterXOF } from '@fneplus/core';
import { ErreurTerminal, terminal } from '@/lib/client-terminal';
import type { EtatReglementLocal, MoyenPaiementTerminal } from '@/lib/protocole-terminal';
import { CodeQR } from './CodeQR';

const OPERATEURS: { code: Exclude<MoyenPaiementTerminal, 'ESPECES'>; libelle: string }[] = [
  { code: 'ORANGE_MONEY', libelle: 'Orange Money' },
  { code: 'MTN_MOMO', libelle: 'MTN Mobile Money' },
  { code: 'WAVE', libelle: 'Wave' },
  { code: 'MOOV_MONEY', libelle: 'Moov Money' },
];

/** Interrogation périodique de l'état pendant qu'un paiement mobile est en attente. */
const INTERVALLE_VERIFICATION_MS = 4_000;

/**
 * Panneau d'encaissement, affiché sous le reçu.
 *
 * Deux chemins, à la disponibilité réseau différente :
 *
 *  - **Espèces** : le montant est en main, le règlement s'enregistre hors ligne
 *    et immédiatement — comme l'émission de la facture elle-même.
 *  - **Mobile money** : la demande exige le réseau (elle sollicite un
 *    prestataire externe), mais une fois créée, le client règle depuis son
 *    propre téléphone. Le panneau interroge alors périodiquement l'état du
 *    règlement : c'est le rapprochement automatique promis par le cahier des
 *    charges, pas une vérification manuelle après coup.
 */
export function PanneauEncaissement({ factureId }: { factureId: string }) {
  const [etat, setEtat] = useState<EtatReglementLocal | null>(null);
  const [montantSaisi, setMontantSaisi] = useState('');
  const [operateurChoisi, setOperateurChoisi] = useState<Exclude<
    MoyenPaiementTerminal,
    'ESPECES'
  > | null>(null);
  const [telephone, setTelephone] = useState('');
  const [demandeEnCours, setDemandeEnCours] = useState<{
    reference?: string;
    lienPaiement?: string;
  } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const rafraichir = useCallback(async () => {
    const e = await terminal().etatReglement(factureId);
    setEtat(e);
    return e;
  }, [factureId]);

  useEffect(() => {
    void rafraichir().then((e) => {
      if (e) setMontantSaisi(String(e.resteADevoir));
    });
  }, [rafraichir]);

  // Rapprochement automatique : tant qu'une demande mobile money est ouverte et
  // que la facture n'est pas soldée, on revérifie régulièrement. Le webhook du
  // prestataire fait le travail côté serveur ; ici on ne fait que rafraîchir
  // l'écran pour que le caissier voie le règlement dès qu'il arrive.
  const enAttenteDeConfirmation = Boolean(demandeEnCours) && (etat?.resteADevoir ?? 0) > 0;
  const minuteurRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enAttenteDeConfirmation) {
      if (minuteurRef.current) clearInterval(minuteurRef.current);
      return;
    }
    minuteurRef.current = setInterval(() => {
      void rafraichir().then((e) => {
        if (e && e.resteADevoir <= 0) {
          setDemandeEnCours(null);
          setMessage('Paiement reçu et rapproché automatiquement.');
        }
      });
    }, INTERVALLE_VERIFICATION_MS);
    return () => {
      if (minuteurRef.current) clearInterval(minuteurRef.current);
    };
  }, [enAttenteDeConfirmation, rafraichir]);

  const encaisserEspeces = useCallback(async () => {
    const montant = Number(montantSaisi);
    if (!Number.isInteger(montant) || montant <= 0) {
      setErreur('Indiquez un montant entier en francs CFA.');
      return;
    }
    setOccupe(true);
    setErreur(null);
    try {
      const nouvel = await terminal().encaisserEspeces({ factureId, montant });
      setEtat(nouvel);
      setMontantSaisi(String(nouvel.resteADevoir));
      setMessage(
        nouvel.resteADevoir === 0
          ? 'Facture soldée.'
          : `Reste ${formaterXOF(nouvel.resteADevoir)} à régler.`,
      );
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }, [factureId, montantSaisi]);

  const demanderMobile = useCallback(
    async (operateur: Exclude<MoyenPaiementTerminal, 'ESPECES'>) => {
      const montant = Number(montantSaisi);
      if (!Number.isInteger(montant) || montant <= 0) {
        setErreur('Indiquez un montant entier en francs CFA.');
        return;
      }
      setOccupe(true);
      setErreur(null);
      setMessage(null);
      try {
        const resultat = await terminal().demanderPaiementMobile({
          factureId,
          moyen: operateur,
          montant,
          ...(telephone ? { telephone } : {}),
        });
        setDemandeEnCours({
          ...(resultat.reference ? { reference: resultat.reference } : {}),
          ...(resultat.lienPaiement ? { lienPaiement: resultat.lienPaiement } : {}),
        });
        setOperateurChoisi(operateur);
      } catch (e) {
        if (e instanceof ErreurTerminal && e.nom === 'ErreurReseau') {
          setErreur(
            'Le paiement mobile money exige une connexion. Réessayez, ou encaissez en espèces.',
          );
        } else {
          setErreur(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setOccupe(false);
      }
    },
    [factureId, montantSaisi, telephone],
  );

  if (!etat) return null;

  if (etat.resteADevoir === 0 && !demandeEnCours) {
    return (
      <Carte titre="Règlement">
        <LigneInfo libelle="Statut" valeur={<Badge ton="succes">Facture soldée</Badge>} />
        <LigneInfo libelle="Montant réglé" valeur={formaterXOF(etat.montantRegle)} numerique />
      </Carte>
    );
  }

  return (
    <Carte titre="Encaisser">
      {erreur ? <Alerte ton="erreur">{erreur}</Alerte> : null}
      {message ? <Alerte ton="info">{message}</Alerte> : null}

      <LigneInfo libelle="Total TTC" valeur={formaterXOF(etat.totalTTC)} numerique />
      {etat.montantRegle > 0 ? (
        <LigneInfo libelle="Déjà réglé" valeur={formaterXOF(etat.montantRegle)} numerique />
      ) : null}
      <LigneInfo
        libelle="Reste à devoir"
        valeur={<strong className="fne-chiffres">{formaterXOF(etat.resteADevoir)}</strong>}
      />

      {demandeEnCours ? (
        <div className="fne-pile" style={{ marginTop: 'var(--fne-esp-4)' }}>
          <Alerte ton="attente">
            En attente du règlement par{' '}
            {operateurChoisi ? libelleOperateur(operateurChoisi) : 'mobile money'}. Le client règle
            depuis son téléphone ; cet écran se met à jour tout seul.
          </Alerte>
          {demandeEnCours.lienPaiement ? (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <CodeQR contenu={demandeEnCours.lienPaiement} taille={140} provisoire={false} />
            </div>
          ) : null}
          <Bouton
            variante="secondaire"
            onClick={() => {
              setDemandeEnCours(null);
              void rafraichir();
            }}
          >
            Annuler l’attente
          </Bouton>
        </div>
      ) : (
        <div className="fne-pile" style={{ marginTop: 'var(--fne-esp-4)' }}>
          <label className="fne-champ">
            <span>Montant encaissé (F CFA)</span>
            <input
              inputMode="numeric"
              value={montantSaisi}
              onChange={(e) => setMontantSaisi(e.target.value.replace(/\D/g, ''))}
            />
          </label>

          <Bouton pleineLargeur onClick={() => void encaisserEspeces()} disabled={occupe}>
            {occupe
              ? 'Enregistrement…'
              : `Encaisser ${formaterXOF(Number(montantSaisi) || 0)} en espèces`}
          </Bouton>

          <label className="fne-champ">
            <span>Téléphone du client (mobile money)</span>
            <input
              type="tel"
              inputMode="tel"
              value={telephone}
              onChange={(e) => setTelephone(e.target.value)}
              placeholder="Facultatif"
            />
          </label>

          <div className="fne-grille-articles">
            {OPERATEURS.map((o) => (
              <button
                key={o.code}
                type="button"
                className="fne-article"
                onClick={() => void demanderMobile(o.code)}
                disabled={occupe}
              >
                <span className="fne-article__nom">{o.libelle}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Carte>
  );
}

function libelleOperateur(code: string): string {
  return OPERATEURS.find((o) => o.code === code)?.libelle ?? code;
}
