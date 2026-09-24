/**
 * Page de repli servie par le service worker quand une navigation échoue et que
 * rien n'est en cache. Elle ne doit dépendre d'aucune ressource distante.
 */
export default function PageHorsLigne() {
  return (
    <div className="fne-app">
      <header className="fne-entete">
        <div className="fne-entete__marque">
          FNE<span aria-hidden="true">+</span>
        </div>
      </header>
      <main className="fne-conteneur fne-contenu">
        <h1 className="fne-titre-page">Cette page n’est pas encore disponible hors ligne</h1>
        <p className="fne-sous-titre">
          Vos factures déjà émises restent enregistrées sur l’appareil et partiront au retour du
          réseau. Revenez à l’accueil pour continuer à facturer.
        </p>
        <div className="fne-actions">
          <a className="fne-bouton fne-bouton--principal" href="/">
            Retour à la facturation
          </a>
        </div>
      </main>
    </div>
  );
}
