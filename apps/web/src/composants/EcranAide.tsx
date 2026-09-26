'use client';

import { Carte } from '@fneplus/ui';

/**
 * Aide et support (Sprint 6 du plan de développement).
 *
 * Base de connaissance minimale — les questions qu'un commerçant se pose
 * réellement à l'usage, pas une documentation exhaustive — plus un canal de
 * contact direct. Le numéro ci-dessous est un espace réservé : à remplacer
 * par le vrai canal de support avant le pilote terrain, comme les autres
 * hypothèses de travail du plan (§1).
 */
const NUMERO_SUPPORT_WHATSAPP = '+2250000000000';

const QUESTIONS: { question: string; reponse: string }[] = [
  {
    question: 'Le réseau coupe pendant une vente : la facture part-elle quand même ?',
    reponse:
      'Oui. La facture est calculée, numérotée et remise au client entièrement sur l’appareil, sans aucun appel réseau. Elle part vers la DGI dès que le réseau revient — vous n’avez rien à refaire.',
  },
  {
    question: 'Pourquoi le QR dit-il « en attente de certification » ?',
    reponse:
      'Le code est produit immédiatement pour prouver que la facture n’a pas été modifiée. L’identifiant officiel de la DGI, lui, n’arrive qu’à la synchronisation suivante. Le statut se met à jour tout seul dès que la certification arrive.',
  },
  {
    question: 'Mon attestation de régularité fiscale (ARF) est-elle suivie automatiquement ?',
    reponse:
      'FNE+ vous alerte 30 jours avant l’échéance, pas seulement le jour où elle expire. La saisie de l’attestation elle-même reste manuelle pour l’instant, tant qu’aucune interconnexion avec la DGI ne l’automatise.',
  },
  {
    question: 'Un paiement mobile money mal reçu bloque-t-il la facture ?',
    reponse:
      'Non. Vous pouvez toujours encaisser le complément en espèces. Le rapprochement mobile money se fait automatiquement dès que le prestataire confirme le paiement, sans action de votre part.',
  },
  {
    question: 'Que faire si l’écran « À vérifier » signale une anomalie ?',
    reponse:
      'Chaque anomalie explique ce qui s’est passé et l’action corrective à faire — jamais un code d’erreur seul. Une réserve de numéros épuisée, par exemple, se résout en vous connectant quelques secondes pour en recharger une.',
  },
];

export function EcranAide() {
  const lienWhatsApp = `https://wa.me/${NUMERO_SUPPORT_WHATSAPP.replace(/\D/g, '')}`;

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Aide et support</h1>
        <p className="fne-sous-titre">
          Les questions les plus fréquentes, et comment nous joindre.
        </p>
      </header>

      <Carte titre="Contacter le support">
        <p style={{ margin: '0 0 var(--fne-esp-3)', fontSize: '0.875rem' }}>
          Une question qui ne trouve pas de réponse ci-dessous ? Écrivez-nous directement.
        </p>
        <a
          href={lienWhatsApp}
          target="_blank"
          rel="noreferrer"
          className="fne-bouton fne-bouton--principal"
        >
          Discuter sur WhatsApp
        </a>
      </Carte>

      <Carte titre="Questions fréquentes">
        <div className="fne-pile">
          {QUESTIONS.map((q) => (
            <details key={q.question} className="fne-question">
              <summary>{q.question}</summary>
              <p>{q.reponse}</p>
            </details>
          ))}
        </div>
      </Carte>
    </>
  );
}
