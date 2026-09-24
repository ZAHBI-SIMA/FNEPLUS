/**
 * Service worker FNE+.
 *
 * Écrit à la main plutôt que généré : la stratégie de cache est une décision
 * produit ici, pas un détail d'outillage. Le terminal doit s'ouvrir et facturer
 * après plusieurs jours sans réseau, ce qui impose un contrôle explicite de ce
 * qui est gardé et de ce qui est réclamé.
 *
 * Trois règles :
 *  1. La coquille applicative est servie depuis le cache d'abord. L'application
 *     s'ouvre donc instantanément, réseau ou pas.
 *  2. Les appels à l'API ne sont JAMAIS mis en cache. Une réponse périmée sur un
 *     statut de transmission serait pire que pas de réponse du tout.
 *  3. Le runtime SQLite et les assets versionnés sont immuables : cache d'abord,
 *     sans revalidation.
 */

const VERSION = 'fneplus-v1';
const CACHE_COQUILLE = `${VERSION}-coquille`;
const CACHE_STATIQUE = `${VERSION}-statique`;

/** Ressources sans lesquelles l'application ne peut pas démarrer hors ligne. */
const COQUILLE = ['/', '/hors-ligne', '/manifest.webmanifest'];

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_COQUILLE);
      // `reload` force le contournement du cache HTTP : on ne veut pas figer une
      // version périmée au moment même de l'installation.
      await cache.addAll(COQUILLE.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    (async () => {
      const noms = await caches.keys();
      await Promise.all(
        noms.filter((nom) => !nom.startsWith(VERSION)).map((nom) => caches.delete(nom)),
      );
      await self.clients.claim();
    })(),
  );
});

function estRequeteApi(url) {
  return url.pathname.startsWith('/api/');
}

function estAssetImmuable(url) {
  return url.pathname.startsWith('/sqlite3/') || url.pathname.startsWith('/_next/static/');
}

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;
  if (requete.method !== 'GET') return;

  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) return;

  // Règle 2 : l'API passe toujours par le réseau. Hors ligne, l'échec est
  // attendu et géré par l'outbox, pas masqué par une réponse en cache.
  if (estRequeteApi(url)) return;

  // Règle 3 : assets immuables.
  if (estAssetImmuable(url)) {
    evenement.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_STATIQUE);
        const enCache = await cache.match(requete);
        if (enCache) return enCache;

        const reponse = await fetch(requete);
        if (reponse.ok) cache.put(requete, reponse.clone());
        return reponse;
      })(),
    );
    return;
  }

  // Règle 1 : navigation — cache d'abord, réseau en arrière-plan pour la suite.
  if (requete.mode === 'navigate') {
    evenement.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_COQUILLE);
        const enCache = await cache.match(requete, { ignoreSearch: true });

        const reseau = fetch(requete)
          .then((reponse) => {
            if (reponse.ok) cache.put(requete, reponse.clone());
            return reponse;
          })
          .catch(() => null);

        if (enCache) return enCache;

        const reponse = await reseau;
        if (reponse) return reponse;

        const repli = await cache.match('/hors-ligne');
        return (
          repli ??
          new Response(
            '<!doctype html><meta charset="utf-8"><title>Hors ligne</title><p>Application indisponible hors ligne. Reconnectez-vous une fois pour l’installer.</p>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          )
        );
      })(),
    );
    return;
  }

  // Reste : réseau d'abord, repli sur le cache.
  evenement.respondWith(
    (async () => {
      try {
        const reponse = await fetch(requete);
        if (reponse.ok) {
          const cache = await caches.open(CACHE_STATIQUE);
          cache.put(requete, reponse.clone());
        }
        return reponse;
      } catch (erreur) {
        const enCache = await caches.match(requete);
        if (enCache) return enCache;
        throw erreur;
      }
    })(),
  );
});

/**
 * Synchronisation en arrière-plan.
 *
 * Déclenchée par le navigateur au retour du réseau, même si l'application a été
 * fermée entre-temps. C'est ce qui permet à une facture émise le soir dans une
 * zone sans couverture de partir toute seule le lendemain matin.
 */
self.addEventListener('sync', (evenement) => {
  if (evenement.tag !== 'fneplus-outbox') return;
  evenement.waitUntil(notifierClients('SYNCHRONISER'));
});

self.addEventListener('periodicsync', (evenement) => {
  if (evenement.tag !== 'fneplus-outbox-periodique') return;
  evenement.waitUntil(notifierClients('SYNCHRONISER'));
});

async function notifierClients(type) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) client.postMessage({ type });
}

self.addEventListener('message', (evenement) => {
  if (evenement.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
