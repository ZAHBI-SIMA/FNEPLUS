/**
 * Simulateur de l'API FNE (DGI).
 *
 * Raison d'être : l'accès au bac à sable officiel n'est pas acquis (point
 * bloquant n° 2 du plan de développement). Sans simulateur, le connecteur DGI ne
 * peut être ni écrit ni éprouvé, et le calendrier du MVP saute.
 *
 * Ce simulateur n'a pas vocation à imiter fidèlement les réponses de la DGI —
 * le schéma exact reste à confirmer. Il sert à éprouver le CONNECTEUR : sa file,
 * son rejeu, son idempotence, sa tolérance à la lenteur et aux pannes. Il expose
 * donc un panneau de contrôle pour injecter latence, erreurs et coupures, qui
 * est l'essentiel de sa valeur.
 *
 * Aucune dépendance : il doit démarrer en une seconde sur le poste de n'importe
 * quel développeur et dans l'intégration continue.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4010);

/* ------------------------------------------------------------------ */
/* État en mémoire                                                     */
/* ------------------------------------------------------------------ */

/** Factures enregistrées, par identifiant de facture. */
const factures = new Map();
/** Réponses déjà produites, par clé d'idempotence. */
const idempotence = new Map();
/** Numéros déjà vus par entreprise : détecte les doublons de séquence. */
const numerosParEntreprise = new Map();

/** Comportement simulé. Piloté à chaud par POST /_simulateur/config. */
const chaos = {
  /** Latence artificielle ajoutée à chaque réponse, en millisecondes. */
  latenceMs: 0,
  /** Probabilité d'une erreur 503 (0 à 1) : panne temporaire de l'API. */
  tauxErreur: 0,
  /** Probabilité d'un rejet métier 422 (0 à 1). */
  tauxRejet: 0,
  /** Coupure totale : la connexion est fermée sans réponse. */
  panne: false,
};

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function repondre(reponse, code, corps) {
  const donnees = JSON.stringify(corps, null, 2);
  reponse.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(donnees),
  });
  reponse.end(donnees);
}

async function lireCorps(requete) {
  const morceaux = [];
  for await (const morceau of requete) morceaux.push(morceau);
  if (morceaux.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
  } catch {
    return undefined; // corps illisible
  }
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Contrôles reproduisant l'esprit des rejets attendus côté DGI.
 * Chaque motif est rédigé en français et dit quoi corriger : c'est ce texte que
 * verra le commerçant, pas un code d'erreur.
 */
function valider(facture, entrepriseId) {
  const motifs = [];

  // Le schéma contrôlé ici est celui produit par la couche d'anticorruption
  // (`apps/api/src/dgi/anticorruption.ts`), pas le modèle interne de FNE+. Les
  // deux doivent rester alignés : c'est tout l'intérêt d'avoir une couche de
  // traduction, et ce simulateur sert justement à le vérifier.
  if (!facture?.numero) {
    motifs.push('Le numéro de facture est absent.');
  }
  if (!facture?.ncc) {
    motifs.push('Le numéro de compte contribuable de l’émetteur est absent.');
  }
  if (!facture?.dateEmission) {
    motifs.push('La date d’émission est absente.');
  }
  if (!Array.isArray(facture?.lignes) || facture.lignes.length === 0) {
    motifs.push('La facture ne comporte aucune ligne.');
  }
  if (typeof facture?.totaux?.totalTTC !== 'number') {
    motifs.push('Le total TTC est absent ou n’est pas un montant.');
  }
  if (!facture?.empreinte) {
    motifs.push('L’empreinte d’intégrité de la facture est absente.');
  }
  if (!facture?.versionMapping) {
    motifs.push('La version de mapping n’est pas renseignée.');
  }

  const dejaVus = numerosParEntreprise.get(entrepriseId);
  if (dejaVus?.has(facture?.numero)) {
    motifs.push(
      `Le numéro ${facture.numero} a déjà été transmis. Vérifiez la réserve de numéros de ce terminal.`,
    );
  }

  return motifs;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function enregistrerFacture(requete, reponse) {
  const corps = await lireCorps(requete);

  if (corps === undefined || corps === null) {
    return repondre(reponse, 400, {
      code: 'CORPS_INVALIDE',
      message: 'Le corps de la requête n’est pas un JSON valide.',
    });
  }

  // Idempotence : rejouer un envoi interrompu ne doit jamais créer de doublon.
  const cle = requete.headers['idempotency-key'];
  if (cle && idempotence.has(cle)) {
    const memorisee = idempotence.get(cle);
    reponse.setHeader('Idempotent-Replay', 'true');
    return repondre(reponse, memorisee.code, memorisee.corps);
  }

  const facture = corps.facture ?? corps;
  const entrepriseId = facture?.entrepriseId ?? 'inconnue';

  // Rejet métier simulé.
  if (Math.random() < chaos.tauxRejet) {
    const resultat = {
      code: 422,
      corps: {
        statut: 'REJETEE',
        motifs: ['Rejet simulé par le bac à sable, pour éprouver le traitement des refus.'],
      },
    };
    if (cle) idempotence.set(cle, resultat);
    return repondre(reponse, resultat.code, resultat.corps);
  }

  const motifs = valider(facture, entrepriseId);
  if (motifs.length > 0) {
    const resultat = { code: 422, corps: { statut: 'REJETEE', motifs } };
    if (cle) idempotence.set(cle, resultat);
    return repondre(reponse, resultat.code, resultat.corps);
  }

  const identifiantCertification = `DGI-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const horodatageCertifie = new Date().toISOString();

  factures.set(facture.id ?? facture.numero, {
    facture,
    identifiantCertification,
    horodatageCertifie,
  });

  if (!numerosParEntreprise.has(entrepriseId)) numerosParEntreprise.set(entrepriseId, new Set());
  numerosParEntreprise.get(entrepriseId).add(facture.numero);

  const resultat = {
    code: 201,
    corps: {
      statut: 'CERTIFIEE',
      identifiantCertification,
      horodatageCertifie,
      // Le contenu réel du QR reste à confirmer auprès de la DGI : c'est le
      // point bloquant n° 1 du plan. On renvoie ici une chaîne de la forme
      // attendue pour que le connecteur puisse être écrit.
      contenuQR: [
        facture.numero,
        facture.ncc,
        facture.totaux?.totalTTC,
        identifiantCertification,
      ].join('|'),
    },
  };

  if (cle) idempotence.set(cle, resultat);
  return repondre(reponse, resultat.code, resultat.corps);
}

function consulterFacture(reponse, identifiant) {
  const enregistree = factures.get(identifiant);
  if (!enregistree) {
    return repondre(reponse, 404, {
      code: 'INTROUVABLE',
      message: 'Aucune facture enregistrée sous cet identifiant.',
    });
  }
  return repondre(reponse, 200, {
    statut: 'CERTIFIEE',
    identifiantCertification: enregistree.identifiantCertification,
    horodatageCertifie: enregistree.horodatageCertifie,
    numero: enregistree.facture.numero,
  });
}

async function configurerChaos(requete, reponse) {
  const corps = await lireCorps(requete);
  if (!corps || typeof corps !== 'object') {
    return repondre(reponse, 400, { message: 'Configuration attendue au format JSON.' });
  }
  for (const cle of ['latenceMs', 'tauxErreur', 'tauxRejet', 'panne']) {
    if (cle in corps) chaos[cle] = corps[cle];
  }
  console.log('[dgi-sim] comportement mis à jour :', chaos);
  return repondre(reponse, 200, chaos);
}

/* ------------------------------------------------------------------ */
/* Serveur                                                             */
/* ------------------------------------------------------------------ */

const serveur = createServer(async (requete, reponse) => {
  const url = new URL(requete.url, `http://${requete.headers.host}`);

  // Panneau de contrôle : jamais soumis au chaos, sinon on ne peut plus le
  // désactiver une fois la panne simulée activée.
  if (url.pathname === '/_simulateur/config') {
    if (requete.method === 'POST') return configurerChaos(requete, reponse);
    if (requete.method === 'GET') return repondre(reponse, 200, chaos);
  }

  if (url.pathname === '/_simulateur/reinitialiser' && requete.method === 'POST') {
    factures.clear();
    idempotence.clear();
    numerosParEntreprise.clear();
    return repondre(reponse, 200, { message: 'Simulateur réinitialisé.' });
  }

  if (url.pathname === '/api/v1/sante') {
    return repondre(reponse, 200, { statut: 'ok', factures: factures.size });
  }

  // Coupure totale : la connexion est fermée sans réponse. C'est le pire cas
  // pour un client HTTP, et celui que le connecteur doit savoir encaisser.
  if (chaos.panne) {
    requete.socket.destroy();
    return;
  }

  if (chaos.latenceMs > 0) await attendre(chaos.latenceMs);

  if (Math.random() < chaos.tauxErreur) {
    return repondre(reponse, 503, {
      code: 'SERVICE_INDISPONIBLE',
      message: 'Le service FNE est momentanément indisponible. Réessayez plus tard.',
    });
  }

  if (url.pathname === '/api/v1/factures' && requete.method === 'POST') {
    return enregistrerFacture(requete, reponse);
  }

  const correspondance = url.pathname.match(/^\/api\/v1\/factures\/(.+)$/);
  if (correspondance && requete.method === 'GET') {
    return consulterFacture(reponse, decodeURIComponent(correspondance[1]));
  }

  return repondre(reponse, 404, { code: 'ROUTE_INCONNUE', message: 'Route inconnue.' });
});

serveur.listen(PORT, () => {
  console.log(`[dgi-sim] Simulateur FNE à l'écoute sur http://localhost:${PORT}`);
  console.log('[dgi-sim] Panneau de contrôle : POST /_simulateur/config');
  console.log('[dgi-sim]   { "latenceMs": 2000, "tauxErreur": 0.3, "tauxRejet": 0.1, "panne": false }');
});

export { serveur, chaos };
