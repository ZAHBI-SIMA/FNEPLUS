import type { Metadata, Viewport } from 'next';
import './globals.css';
import { EnregistrementServiceWorker } from '@/composants/EnregistrementServiceWorker';

export const metadata: Metadata = {
  title: 'FNE+ — Facturation conforme',
  description:
    'Émettez des factures conformes FNE en quelques secondes, avec ou sans réseau. Conçu pour la Côte d’Ivoire.',
  manifest: '/manifest.webmanifest',
  applicationName: 'FNE+',
  appleWebApp: {
    capable: true,
    title: 'FNE+',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [{ url: '/icones/favicon-32.png', sizes: '32x32', type: 'image/png' }],
    apple: [{ url: '/icones/apple-touch-icon.png', sizes: '180x180' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#0f6e4c',
  width: 'device-width',
  initialScale: 1,
  // Le zoom reste autorisé : l'interdire casse l'accessibilité pour les
  // utilisateurs presbytes, qui sont nombreux parmi les gérants de commerce.
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function LayoutRacine({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr-CI">
      <body>
        {children}
        <EnregistrementServiceWorker />
      </body>
    </html>
  );
}
