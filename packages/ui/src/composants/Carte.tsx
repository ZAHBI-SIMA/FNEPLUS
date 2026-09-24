import type { ReactNode } from 'react';

export interface ProprietesCarte {
  titre?: string;
  children: ReactNode;
  className?: string;
}

export function Carte({ titre, children, className }: ProprietesCarte) {
  return (
    <section className={['fne-carte', className ?? ''].filter(Boolean).join(' ')}>
      {titre ? <h2 className="fne-carte__titre">{titre}</h2> : null}
      {children}
    </section>
  );
}
