import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Les packages du monorepo sont consommés en TypeScript source, sans étape de
  // build intermédiaire.
  transpilePackages: ['@fneplus/ui', '@fneplus/core'],

  // Le budget de poids est une contrainte produit : chaque kilo-octet est payé en
  // données mobiles par l'utilisateur. Toute augmentation doit être justifiée.
  productionBrowserSourceMaps: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // Le service worker ne doit jamais être servi depuis un cache HTTP :
        // sinon une correction ne parvient plus aux terminaux déjà installés.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/sqlite3/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default config;
