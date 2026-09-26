/**
 * Icônes de la barre latérale.
 *
 * En SVG inline plutôt qu'une bibliothèque externe : une dizaine de tracés ne
 * justifie pas une dépendance, sur une application dont le poids du premier
 * chargement est un budget suivi (`docs/PLAN-DEVELOPPEMENT.md`, chapitre 6).
 * Même gabarit pour toutes — 24×24, trait de 1.75, sans remplissage — pour
 * qu'une icône ajoutée plus tard s'intègre sans dépareiller les autres.
 */

import type { SVGProps } from 'react';

type ProprietesIcone = SVGProps<SVGSVGElement>;

function Icone({ children, ...props }: ProprietesIcone & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconeVente(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M6 8h12l-1 11.5a2 2 0 0 1-2 1.5H9a2 2 0 0 1-2-1.5L6 8Z" />
      <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
    </Icone>
  );
}

export function IconeArticles(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M3 8.2 12 4l9 4.2-9 4.2-9-4.2Z" />
      <path d="M3 8.2v7.3L12 20l9-4.5V8.2" />
      <path d="M12 12.4V20" />
    </Icone>
  );
}

export function IconeClients(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <circle cx="8.5" cy="8" r="3.1" />
      <path d="M2.8 20c0-3.5 2.5-6 5.7-6s5.7 2.5 5.7 6" />
      <circle cx="17" cy="8.6" r="2.5" />
      <path d="M15 14c2.8.5 4.8 2.8 4.8 6" />
    </Icone>
  );
}

export function IconeJournal(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <rect x="3.5" y="3.5" width="7.2" height="7.2" rx="1.4" />
      <rect x="13.3" y="3.5" width="7.2" height="7.2" rx="1.4" />
      <rect x="3.5" y="13.3" width="7.2" height="7.2" rx="1.4" />
      <rect x="13.3" y="13.3" width="7.2" height="7.2" rx="1.4" />
    </Icone>
  );
}

export function IconeAVerifier(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M12 4 2.5 20.5h19L12 4Z" />
      <path d="M12 10v4.3" />
      <circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none" />
    </Icone>
  );
}

export function IconeRapports(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M4 19.5h16" />
      <rect x="6" y="12.5" width="3" height="6" rx="0.5" />
      <rect x="11" y="8.5" width="3" height="10" rx="0.5" />
      <rect x="16" y="4.5" width="3" height="14" rx="0.5" />
    </Icone>
  );
}

export function IconeAide(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.3a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.3 1-1.3 2" />
      <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
    </Icone>
  );
}

export function IconeMultiBoutiques(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M4 10 5 4h14l1 6" />
      <path d="M4 10v8.5a1 1 0 0 0 1 1h4v-6h6v6h4a1 1 0 0 0 1-1V10" />
      <path d="M4 10h16" />
    </Icone>
  );
}

export function IconeAssistantWhatsApp(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M4 5.8A2.3 2.3 0 0 1 6.3 3.5h11.4A2.3 2.3 0 0 1 20 5.8v7.4a2.3 2.3 0 0 1-2.3 2.3H9l-4.4 3.8v-3.8A2.3 2.3 0 0 1 4 13.2V5.8Z" />
    </Icone>
  );
}

export function IconeOCR(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M6 3h12v18l-2.4-1.5L13.2 21l-2.4-1.5L8.4 21 6 19.5V3Z" />
      <path d="M8.7 8h6.6M8.7 11.4h6.6M8.7 14.8h4" />
    </Icone>
  );
}

export function IconeAssistantIA(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <path d="M12 3.5 13.5 8 18 9.5 13.5 11l-1.5 4.5L10.5 11 6 9.5 10.5 8 12 3.5Z" />
      <path d="M18.3 15.2 19 17l1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </Icone>
  );
}

export function IconeFinancement(props: ProprietesIcone) {
  return (
    <Icone {...props}>
      <ellipse cx="11.5" cy="13" rx="7" ry="5" />
      <path d="M12 8V6.3L14.2 5" />
      <circle cx="16" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <path d="M4.5 12.5h-2v3h2" />
      <path d="M8.5 18v2M15 18v2" />
    </Icone>
  );
}
