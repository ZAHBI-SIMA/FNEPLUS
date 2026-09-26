'use client';

import { useEffect, useState } from 'react';
import { Alerte, Badge, Carte } from '@fneplus/ui';
import { terminal } from '@/lib/client-terminal';
import type { SituationARF, StatutARF } from '@/lib/protocole-terminal';

/**
 * Suivi de l'Attestation de Régularité Fiscale.
 *
 * Exigence du cahier des charges : un tableau de bord affichant « en
 * permanence » si l'entreprise est en règle, avec une alerte « avant » toute
 * rupture — une ARF expirée bloque l'accès aux marchés publics, et ça se
 * découvre en général au moment de répondre à un appel d'offres, trop tard
 * pour agir.
 *
 * D'où deux choix : cette tuile est sur l'écran ouvert le plus souvent (pas
 * dans un sous-menu qu'on n'ouvre jamais), et son ton passe à l'orange dès
 * l'entrée dans la fenêtre d'alerte — pas seulement le jour de l'expiration.
 *
 * Appelle le serveur : nécessite le réseau. Hors ligne, la tuile affiche
 * simplement la dernière situation connue plutôt que de bloquer l'écran.
 */
const TONS: Record<StatutARF, 'succes' | 'attente' | 'erreur' | 'neutre'> = {
  A_JOUR: 'succes',
  BIENTOT_EXPIREE: 'attente',
  EXPIREE: 'erreur',
  REVOQUEE: 'erreur',
  AUCUNE: 'neutre',
};

const LIBELLES: Record<StatutARF, string> = {
  A_JOUR: 'À jour',
  BIENTOT_EXPIREE: 'Bientôt expirée',
  EXPIREE: 'Expirée',
  REVOQUEE: 'Révoquée',
  AUCUNE: 'Non renseignée',
};

export function TuileARF() {
  const [situation, setSituation] = useState<SituationARF | null>(null);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    let annule = false;
    terminal()
      .situationARF()
      .then((s) => {
        if (!annule) setSituation(s);
      })
      .catch(() => {
        // Hors ligne ou serveur injoignable : pas d'alerte bloquante, la
        // tuile se contente de ne rien afficher plutôt que de mentir sur
        // une situation qu'elle ne connaît plus.
      })
      .finally(() => {
        if (!annule) setChargement(false);
      });
    return () => {
      annule = true;
    };
  }, []);

  if (chargement || !situation) return null;

  return (
    <Carte titre="Attestation de Régularité Fiscale">
      <div className="fne-actions" style={{ marginBottom: 'var(--fne-esp-3)' }}>
        <Badge ton={TONS[situation.statut]}>{LIBELLES[situation.statut]}</Badge>
        {situation.joursAvantExpiration !== undefined && situation.joursAvantExpiration >= 0 ? (
          <span className="fne-chiffres" style={{ color: 'var(--fne-texte-faible)' }}>
            {situation.joursAvantExpiration} jour{situation.joursAvantExpiration > 1 ? 's' : ''}{' '}
            restants
          </span>
        ) : null}
      </div>

      {situation.statut === 'BIENTOT_EXPIREE' || situation.statut === 'EXPIREE' ? (
        <Alerte ton={situation.statut === 'EXPIREE' ? 'erreur' : 'attente'}>
          {situation.message}
        </Alerte>
      ) : (
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--fne-texte-faible)' }}>
          {situation.message}
        </p>
      )}
    </Carte>
  );
}
