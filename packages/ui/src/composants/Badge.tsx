import type { ReactNode } from 'react';

export type TonBadge = 'neutre' | 'info' | 'attente' | 'succes' | 'erreur';

export interface ProprietesBadge {
  ton?: TonBadge;
  children: ReactNode;
  /**
   * La pastille colorée est décorative : le sens est porté par le texte, jamais
   * par la couleur seule.
   */
  avecPastille?: boolean;
}

export function Badge({ ton = 'neutre', children, avecPastille = true }: ProprietesBadge) {
  return (
    <span className={`fne-badge fne-badge--${ton}`}>
      {avecPastille ? <span className="fne-badge__pastille" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
