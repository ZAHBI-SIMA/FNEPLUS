import dynamique from 'next/dynamic';

/**
 * Le tableau de bord n'est rendu que côté client : il ouvre la base locale
 * SQLite, qui n'existe pas sur le serveur. Le rendu serveur d'une coquille vide
 * serait du poids inutile sur le premier chargement.
 */
const TableauDeBordTerminal = dynamique(
  () => import('@/composants/TableauDeBordTerminal').then((m) => m.TableauDeBordTerminal),
  {
    loading: () => (
      <div className="fne-conteneur fne-contenu">
        <p>Ouverture du terminal…</p>
      </div>
    ),
  },
);

export default function PageAccueil() {
  return (
    <div className="fne-app">
      <header className="fne-entete">
        <div className="fne-entete__marque">
          FNE<span aria-hidden="true">+</span>
          <span>Facturation conforme</span>
        </div>
      </header>
      <TableauDeBordTerminal />
      <footer className="fne-pied">
        Sprint 1 — identité et référentiels. Le bouton d’émission utilise un panier de
        démonstration.
      </footer>
    </div>
  );
}
