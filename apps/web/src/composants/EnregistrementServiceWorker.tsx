'use client';

import { useEffect } from 'react';

/**
 * Enregistrement du service worker.
 *
 * Volontairement fait après le premier rendu : l'installation du cache ne doit
 * pas retarder l'affichage de la première facture. Sur une 3G dégradée, quelques
 * centaines de millisecondes de décalage se voient.
 */
export function EnregistrementServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const enregistrer = async () => {
      try {
        const enregistrement = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

        // Demande de synchronisation périodique. Non supporté partout : l'échec
        // est sans conséquence, l'outbox est aussi poussée au retour du réseau.
        const periodique = (
          enregistrement as ServiceWorkerRegistration & {
            periodicSync?: {
              register: (tag: string, options: { minInterval: number }) => Promise<void>;
            };
          }
        ).periodicSync;
        await periodique?.register('fneplus-outbox-periodique', { minInterval: 60 * 60 * 1000 });
      } catch (erreur) {
        console.warn('[sw] enregistrement impossible', erreur);
      }
    };

    // `load` plutôt qu'un effet immédiat : on laisse la page devenir utilisable
    // avant de consommer de la bande passante pour le cache.
    if (document.readyState === 'complete') void enregistrer();
    else window.addEventListener('load', () => void enregistrer(), { once: true });
  }, []);

  return null;
}
