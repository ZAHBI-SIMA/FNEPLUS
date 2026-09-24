import type { ReactNode } from 'react';

export interface ProprietesLigneInfo {
  libelle: string;
  valeur: ReactNode;
  /** Valeurs numériques : chiffres tabulaires pour un alignement propre en colonne. */
  numerique?: boolean;
}

export function LigneInfo({ libelle, valeur, numerique = false }: ProprietesLigneInfo) {
  return (
    <div className="fne-ligne-info">
      <span className="fne-ligne-info__libelle">{libelle}</span>
      <span
        className={['fne-ligne-info__valeur', numerique ? 'fne-chiffres' : '']
          .filter(Boolean)
          .join(' ')}
      >
        {valeur}
      </span>
    </div>
  );
}
