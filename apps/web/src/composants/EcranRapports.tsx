'use client';

import { useEffect, useState } from 'react';
import { Alerte, Badge, Carte, LigneInfo } from '@fneplus/ui';
import { terminal } from '@/lib/client-terminal';
import type { KpisEntreprise } from '@/lib/protocole-terminal';

/**
 * Rapports et indicateurs (chapitre 10 du cahier des charges).
 *
 * Ce que voit un commerçant ici, c'est son propre usage et sa propre
 * conformité — pas les indicateurs d'adoption ou de rétention de la
 * plateforme, qui n'ont de sens qu'agrégés sur tous les clients et ne
 * concernent que l'exploitant de FNE+, pas chaque boutique individuellement.
 *
 * Appelle le serveur : nécessite le réseau, comme le suivi ARF. Hors ligne,
 * l'écran affiche un message d'attente plutôt qu'un chiffre périmé présenté
 * comme actuel.
 */
export function EcranRapports() {
  const [kpis, setKpis] = useState<KpisEntreprise | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    let annule = false;
    terminal()
      .kpisEntreprise()
      .then((k) => {
        if (!annule) setKpis(k);
      })
      .catch((e: unknown) => {
        if (!annule) setErreur(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!annule) setChargement(false);
      });
    return () => {
      annule = true;
    };
  }, []);

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Rapports et indicateurs</h1>
        <p className="fne-sous-titre">
          Sur les {kpis?.periodeJours ?? 30} derniers jours, votre boutique.
        </p>
      </header>

      {chargement ? <p>Chargement…</p> : null}
      {erreur ? (
        <Alerte ton="attente">
          Indicateurs indisponibles pour l’instant ({erreur}). Ils exigent le réseau ; réessayez une
          fois connecté.
        </Alerte>
      ) : null}

      {kpis ? (
        <>
          <Carte titre="Usage">
            <LigneInfo libelle="Factures émises" valeur={kpis.usage.nombreFactures} numerique />
            <LigneInfo
              libelle="Part émise hors ligne"
              valeur={
                kpis.usage.partHorsLignePourcent === null ? (
                  '—'
                ) : (
                  <span className="fne-chiffres">{kpis.usage.partHorsLignePourcent} %</span>
                )
              }
            />
            <LigneInfo
              libelle="Délai moyen de synchronisation"
              valeur={
                kpis.usage.delaiMoyenSyncSecondes === null
                  ? '—'
                  : formaterDuree(kpis.usage.delaiMoyenSyncSecondes)
              }
            />
          </Carte>

          <Carte titre="Conformité">
            <LigneInfo
              libelle="Factures certifiées par la DGI"
              valeur={kpis.conformite.nombreCertifiees}
              numerique
            />
            <LigneInfo
              libelle={`Transmises dans le délai réglementaire (${kpis.delaiReglementaireHeures} h)`}
              valeur={
                kpis.conformite.partDansLeDelaiPourcent === null ? (
                  <Badge ton="neutre">Aucune facture certifiée sur la période</Badge>
                ) : (
                  <Badge ton={kpis.conformite.partDansLeDelaiPourcent >= 95 ? 'succes' : 'attente'}>
                    {kpis.conformite.partDansLeDelaiPourcent} %
                  </Badge>
                )
              }
            />
          </Carte>
        </>
      ) : null}
    </>
  );
}

function formaterDuree(secondes: number): string {
  if (secondes < 60) return `${secondes} s`;
  if (secondes < 3600) return `${Math.round(secondes / 60)} min`;
  return `${Math.round(secondes / 3600)} h`;
}
