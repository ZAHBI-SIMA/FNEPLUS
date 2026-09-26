'use client';

import { Alerte, Bouton } from '@fneplus/ui';
import { formaterXOF } from '@fneplus/core';
import { CodeQR } from './CodeQR';
import { PanneauEncaissement } from './PanneauEncaissement';
import type { ResultatEmission } from '@/lib/protocole-terminal';

/**
 * Reçu remis au client, affiché juste après l'encaissement.
 *
 * Il est produit et affiché en local, sans aucun appel réseau : le client repart
 * avec son QR même si le terminal est hors ligne depuis trois jours. C'est la
 * promesse centrale du produit, et c'est cet écran qui la matérialise.
 *
 * Pourquoi pas un PDF ici : un PDF à valeur probante doit être scellé (chaîne
 * d'intégrité, horodatage qualifié), et un terminal n'est pas une autorité de
 * confiance. Le PDF/A archivable sera produit et scellé côté serveur au
 * Sprint 4, avec l'archivage légal. Le terminal, lui, remet un reçu imprimable
 * — ce dont le client a besoin dans la boutique.
 */
export function RecuFacture({
  resultat,
  raisonSociale,
  ncc,
  surFermer,
}: {
  resultat: ResultatEmission;
  raisonSociale: string;
  ncc: string;
  surFermer: () => void;
}) {
  const date = new Date(resultat.emiseLe);
  const dateLisible = new Intl.DateTimeFormat('fr-CI', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);

  return (
    <div className="fne-recu-ecran">
      <div className="fne-recu-document" id="recu-imprimable">
        <header className="fne-recu__entete">
          <strong>{raisonSociale}</strong>
          <span>NCC {ncc}</span>
        </header>

        <div className="fne-recu__numero fne-chiffres">{resultat.numero}</div>

        <dl className="fne-recu__infos">
          <div>
            <dt>Date</dt>
            <dd className="fne-chiffres">{dateLisible}</dd>
          </div>
          <div>
            <dt>Client</dt>
            <dd>{resultat.clientNom}</dd>
          </div>
          <div>
            <dt>Total à payer</dt>
            <dd className="fne-chiffres fne-recu__total">{formaterXOF(resultat.totalTTC)}</dd>
          </div>
        </dl>

        <div className="fne-recu__qr">
          <CodeQR contenu={resultat.contenuQR} provisoire={resultat.qrProvisoire} taille={180} />
        </div>

        <p className="fne-recu__pied">
          Facture normalisée électronique · Vérifiable par lecture du code
        </p>
      </div>

      {resultat.qrProvisoire ? (
        <Alerte ton="attente">
          Cette facture n’a pas encore été certifiée par la DGI. Le code remis au client prouve son
          intégrité ; il sera complété par l’identifiant officiel dès la prochaine connexion.
        </Alerte>
      ) : null}

      <p className="fne-recu__mesure">
        Émise en <strong>{resultat.dureeMs.toFixed(0)} ms</strong>, sans appel réseau.
      </p>

      <div className="fne-sans-impression">
        <PanneauEncaissement factureId={resultat.factureId} />
      </div>

      <div className="fne-actions fne-sans-impression">
        <Bouton pleineLargeur onClick={() => window.print()}>
          Imprimer le reçu
        </Bouton>
        <Bouton variante="secondaire" pleineLargeur onClick={surFermer}>
          Nouvelle vente
        </Bouton>
      </div>
    </div>
  );
}
