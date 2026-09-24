import type { ReactNode } from 'react';

export interface ProprietesAlerte {
  ton?: 'info' | 'attente' | 'erreur';
  children: ReactNode;
}

export function Alerte({ ton = 'info', children }: ProprietesAlerte) {
  return (
    <div className={`fne-alerte fne-alerte--${ton}`} role={ton === 'erreur' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
