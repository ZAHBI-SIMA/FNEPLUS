export interface ProprietesBandeauReseau {
  etat: 'EN_LIGNE' | 'HORS_LIGNE' | 'SYNCHRONISATION';
  /** Nombre de commandes en attente dans l'outbox. */
  enAttente: number;
  derniereSyncReussie?: string | undefined;
}

const MODIFICATEUR = {
  EN_LIGNE: 'en-ligne',
  HORS_LIGNE: 'hors-ligne',
  SYNCHRONISATION: 'synchro',
} as const;

function formaterHeure(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('fr-CI', { hour: '2-digit', minute: '2-digit' }).format(d);
}

/**
 * Bandeau d'état, affiché en permanence en haut de l'application.
 *
 * Le message répond toujours à la seule question que se pose le commerçant :
 * « est-ce que mes factures sont parties ? ». Hors ligne n'est jamais présenté
 * comme une panne — c'est un mode de fonctionnement nominal du produit.
 */
export function BandeauReseau({ etat, enAttente, derniereSyncReussie }: ProprietesBandeauReseau) {
  const heure = formaterHeure(derniereSyncReussie);

  const message =
    etat === 'HORS_LIGNE'
      ? enAttente > 0
        ? `Hors ligne — ${enAttente} ${enAttente > 1 ? 'factures gardées' : 'facture gardée'} sur l’appareil`
        : 'Hors ligne — vous pouvez continuer à facturer'
      : etat === 'SYNCHRONISATION'
        ? `Envoi en cours — ${enAttente} en attente`
        : enAttente > 0
          ? `En ligne — ${enAttente} en attente d’envoi`
          : 'En ligne — tout est transmis';

  return (
    <div
      className={`fne-bandeau-reseau fne-bandeau-reseau--${MODIFICATEUR[etat]}`}
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      {heure ? <span className="fne-chiffres">Dernier envoi {heure}</span> : null}
    </div>
  );
}
