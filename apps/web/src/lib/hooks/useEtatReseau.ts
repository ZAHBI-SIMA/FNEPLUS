'use client';

import { useEffect, useState } from 'react';

export interface EtatReseauDetaille {
  enLigne: boolean;
  /** Type de connexion signalé par le navigateur : '4g', '3g', '2g', 'slow-2g'. */
  qualite?: string;
  /** L'utilisateur ou le système a demandé l'économie de données. */
  economieDonnees: boolean;
}

interface ConnectionLike {
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: string, ecouteur: () => void) => void;
  removeEventListener?: (type: string, ecouteur: () => void) => void;
}

/**
 * État réseau du terminal.
 *
 * `navigator.onLine` ment souvent : il est vrai dès qu'une interface réseau est
 * active, même sans accès Internet réel — cas très courant sur un réseau mobile
 * ivoirien saturé. Il sert donc d'indice, pas de vérité : la vérité est le
 * succès ou l'échec de la dernière synchronisation.
 */
export function useEtatReseau(): EtatReseauDetaille {
  const [etat, setEtat] = useState<EtatReseauDetaille>({
    enLigne: true,
    economieDonnees: false,
  });

  useEffect(() => {
    const connexion = (navigator as Navigator & { connection?: ConnectionLike }).connection;

    const rafraichir = () => {
      setEtat({
        enLigne: navigator.onLine,
        ...(connexion?.effectiveType ? { qualite: connexion.effectiveType } : {}),
        economieDonnees: connexion?.saveData === true,
      });
    };

    rafraichir();
    window.addEventListener('online', rafraichir);
    window.addEventListener('offline', rafraichir);
    connexion?.addEventListener?.('change', rafraichir);

    return () => {
      window.removeEventListener('online', rafraichir);
      window.removeEventListener('offline', rafraichir);
      connexion?.removeEventListener?.('change', rafraichir);
    };
  }, []);

  return etat;
}
