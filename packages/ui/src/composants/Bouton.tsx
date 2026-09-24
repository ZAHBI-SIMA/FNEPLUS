import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ProprietesBouton extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: 'principal' | 'secondaire' | 'discret';
  pleineLargeur?: boolean;
  children: ReactNode;
}

export function Bouton({
  variante = 'principal',
  pleineLargeur = false,
  className,
  children,
  ...reste
}: ProprietesBouton) {
  const classes = [
    'fne-bouton',
    `fne-bouton--${variante}`,
    pleineLargeur ? 'fne-bouton--pleine-largeur' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} {...reste}>
      {children}
    </button>
  );
}
