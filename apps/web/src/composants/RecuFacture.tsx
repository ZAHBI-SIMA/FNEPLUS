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
 * La mise en page suit le modèle papier de la facture normalisée (en-tête
 * « FACTURE N° », tableau Réf/Désignation/Qté/PU TTC/Montant TTC, total en
 * pied) : un commerçant qui connaît déjà ce format n'a rien à réapprendre. La
 * case « Cachet des mentions obligatoires » du papier — prévue pour un tampon
 * physique — devient ici l'encadré des mentions légales et du statut de
 * certification : c'est le même rôle, attester la validité du document, tenu
 * par le QR plutôt que par une empreinte d'encre.
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
        <header className="fne-recu__titre">
          <span>Facture n°</span>
          <strong className="fne-chiffres">{resultat.numero}</strong>
        </header>

        <div className="fne-recu__double">
          <div className="fne-recu__mentions">
            <p className="fne-recu__mentions-titre">Mentions obligatoires</p>
            <p className="fne-recu__mentions-raison">{raisonSociale}</p>
            <p>NCC {ncc}</p>
            <p
              className={
                resultat.qrProvisoire
                  ? 'fne-recu__statut fne-recu__statut--attente'
                  : 'fne-recu__statut fne-recu__statut--succes'
              }
            >
              {resultat.qrProvisoire ? 'En attente de certification DGI' : 'Facture certifiée DGI'}
            </p>
          </div>

          <div className="fne-recu__qr">
            <CodeQR contenu={resultat.contenuQR} provisoire={resultat.qrProvisoire} taille={140} />
          </div>
        </div>

        <dl className="fne-recu__infos">
          <div>
            <dt>Date</dt>
            <dd className="fne-chiffres">{dateLisible}</dd>
          </div>
          <div>
            <dt>Client</dt>
            <dd>{resultat.clientNom}</dd>
          </div>
          {resultat.clientAdresse ? (
            <div>
              <dt>Adresse</dt>
              <dd>{resultat.clientAdresse}</dd>
            </div>
          ) : null}
        </dl>

        <table className="fne-recu__tableau">
          <thead>
            <tr>
              <th scope="col">Réf</th>
              <th scope="col">Désignation</th>
              <th scope="col">Qté</th>
              <th scope="col">PU TTC</th>
              <th scope="col">Montant TTC</th>
            </tr>
          </thead>
          <tbody>
            {resultat.lignes.map((ligne, index) => (
              <tr key={index}>
                <td className="fne-chiffres">{index + 1}</td>
                <td>{ligne.designation}</td>
                <td className="fne-chiffres">{ligne.quantite}</td>
                <td className="fne-chiffres">
                  {formaterXOF(ligne.prixUnitaireTTC, { avecDevise: false })}
                </td>
                <td className="fne-chiffres">
                  {formaterXOF(ligne.montantTTC, { avecDevise: false })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="fne-recu__total-ligne">
          <span>Montant Total TTC</span>
          <strong className="fne-chiffres">{formaterXOF(resultat.totalTTC)}</strong>
        </div>

        <p className="fne-recu__pied">
          {resultat.totalTVA > 0
            ? `Dont TVA ${formaterXOF(resultat.totalTVA)}`
            : 'TVA non applicable à ce régime fiscal.'}
        </p>
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
