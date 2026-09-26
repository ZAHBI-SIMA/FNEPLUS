/**
 * Simulateur d'agrégateur mobile money.
 *
 * Raison d'être : l'accès aux API Orange Money, MTN, Wave et Moov n'est pas
 * acquis (point bloquant n° 4 du plan de développement), et le délai annoncé va
 * de deux à huit semaines selon la voie retenue. Sans simulateur, l'encaissement
 * ne peut être ni écrit ni éprouvé.
 *
 * Il imite le fonctionnement commun aux agrégateurs du marché ivoirien
 * (CinetPay, PayDunya, Hub2) : on crée une demande de paiement, on obtient un
 * lien à présenter au client, et le règlement est notifié par webhook.
 *
 * Ce qui compte ici n'est pas la fidélité du schéma — il sera à refaire — mais
 * la possibilité d'éprouver le CONNECTEUR : webhook en retard, webhook rejoué,
 * signature invalide, paiement abandonné, montant différent de celui attendu.
 * Ce sont ces cas-là qui font perdre de l'argent en production.
 */

import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4020);

/**
 * Secret de signature des webhooks.
 *
 * En production, il est fourni par l'agrégateur et permet de vérifier qu'une
 * notification de paiement vient bien de lui. Sans cette vérification, n'importe
 * qui pourrait déclarer une facture payée.
 */
const SECRET = process.env.MOMO_SECRET ?? 'secret-momo-de-developpement';

/** Opérateurs couverts. */
const OPERATEURS = ['ORANGE_MONEY', 'MTN_MOMO', 'WAVE', 'MOOV_MONEY'];

/* ------------------------------------------------------------------ */
/* État en mémoire                                                     */
/* ------------------------------------------------------------------ */

/** Demandes de paiement, par référence. */
const demandes = new Map();

/** Comportement simulé, piloté par POST /_simulateur/config. */
const chaos = {
  latenceMs: 0,
  /** Probabilité d'une erreur 503 à la création d'une demande. */
  tauxErreur: 0,
  /** Délai avant l'envoi du webhook de confirmation, en millisecondes. */
  delaiWebhookMs: 500,
  /** Le webhook est envoyé deux fois : cas fréquent chez les agrégateurs. */
  webhookEnDouble: false,
  /** Signature volontairement invalide, pour éprouver le rejet. */
  signatureInvalide: false,
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
  for await (const m of requete) morceaux.push(m);
  if (morceaux.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
  } catch {
    return undefined;
  }
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

export function signer(charge, secret = SECRET) {
  return createHmac('sha256', secret).update(JSON.stringify(charge)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

async function notifier(demande, statut) {
  if (!demande.urlWebhook) return;

  const charge = {
    reference: demande.reference,
    referenceExterne: demande.referenceExterne,
    statut,
    montant: demande.montant,
    operateur: demande.operateur,
    telephone: demande.telephone,
    regleLe: new Date().toISOString(),
  };

  const signature = chaos.signatureInvalide ? 'signature-invalide' : signer(charge);

  const envoyer = async () => {
    try {
      await fetch(demande.urlWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Momo-Signature': signature },
        body: JSON.stringify(charge),
      });
    } catch (erreur) {
      console.warn('[momo-sim] webhook non délivré :', String(erreur));
    }
  };

  await attendre(chaos.delaiWebhookMs);
  await envoyer();

  // Un agrégateur qui n'a pas reçu d'accusé renvoie la notification. Le
  // connecteur doit donc être idempotent — c'est précisément ce qu'on éprouve.
  if (chaos.webhookEnDouble) {
    await attendre(200);
    await envoyer();
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function creerDemande(requete, reponse) {
  const corps = await lireCorps(requete);

  if (!corps || typeof corps !== 'object') {
    return repondre(reponse, 400, { code: 'CORPS_INVALIDE', message: 'JSON attendu.' });
  }

  const motifs = [];
  if (typeof corps.montant !== 'number' || corps.montant <= 0) {
    motifs.push('Le montant doit être un entier de francs CFA strictement positif.');
  }
  if (!Number.isInteger(corps.montant)) {
    motifs.push('Le franc CFA n’a pas de décimale : le montant doit être entier.');
  }
  if (!OPERATEURS.includes(corps.operateur)) {
    motifs.push(`Opérateur inconnu. Attendu : ${OPERATEURS.join(', ')}.`);
  }
  if (!corps.referenceExterne) {
    motifs.push('La référence de la facture est absente.');
  }

  if (motifs.length > 0) {
    return repondre(reponse, 422, { statut: 'REFUSEE', motifs });
  }

  // Idempotence : une même facture ne doit pas produire deux demandes de
  // paiement, sinon le client risque de payer deux fois.
  const existante = [...demandes.values()].find(
    (d) => d.referenceExterne === corps.referenceExterne && d.statut === 'EN_ATTENTE',
  );
  if (existante) {
    reponse.setHeader('Idempotent-Replay', 'true');
    return repondre(reponse, 200, vueDemande(existante));
  }

  const reference = `MOMO-${randomUUID().slice(0, 12).toUpperCase()}`;
  const demande = {
    reference,
    referenceExterne: corps.referenceExterne,
    montant: corps.montant,
    operateur: corps.operateur,
    telephone: corps.telephone ?? null,
    urlWebhook: corps.urlWebhook ?? null,
    statut: 'EN_ATTENTE',
    creeeLe: new Date().toISOString(),
  };
  demandes.set(reference, demande);

  return repondre(reponse, 201, vueDemande(demande));
}

function vueDemande(demande) {
  return {
    reference: demande.reference,
    referenceExterne: demande.referenceExterne,
    montant: demande.montant,
    operateur: demande.operateur,
    statut: demande.statut,
    // Lien à présenter au client : en production, il ouvre l'application de
    // l'opérateur ou une page de paiement de l'agrégateur.
    lienPaiement: `http://localhost:${PORT}/payer/${demande.reference}`,
    creeeLe: demande.creeeLe,
  };
}

/**
 * Confirme un paiement.
 *
 * Remplace le geste du client dans son application mobile money. Le `montant`
 * peut être forcé pour éprouver le cas d'un règlement partiel ou excédentaire.
 */
async function confirmerPaiement(requete, reponse, reference) {
  const demande = demandes.get(reference);
  if (!demande) {
    return repondre(reponse, 404, { code: 'INTROUVABLE', message: 'Demande inconnue.' });
  }

  const corps = (await lireCorps(requete)) ?? {};
  if (typeof corps.montant === 'number') demande.montant = corps.montant;

  const statut = corps.statut ?? 'REGLEE';
  demande.statut = statut;

  // Notification hors du cycle de réponse : l'agrégateur répond immédiatement
  // et notifie ensuite, comme en production.
  void notifier(demande, statut);

  return repondre(reponse, 200, { ...vueDemande(demande), notificationEnvoyee: true });
}

/* ------------------------------------------------------------------ */
/* Serveur                                                             */
/* ------------------------------------------------------------------ */

const serveur = createServer(async (requete, reponse) => {
  const url = new URL(requete.url, `http://${requete.headers.host}`);

  // Le panneau de contrôle échappe au chaos, sinon on ne pourrait plus
  // désactiver une panne une fois activée.
  if (url.pathname === '/_simulateur/config') {
    if (requete.method === 'POST') {
      const corps = (await lireCorps(requete)) ?? {};
      for (const cle of Object.keys(chaos)) {
        if (cle in corps) chaos[cle] = corps[cle];
      }
      console.log('[momo-sim] comportement mis à jour :', chaos);
      return repondre(reponse, 200, chaos);
    }
    if (requete.method === 'GET') return repondre(reponse, 200, chaos);
  }

  if (url.pathname === '/_simulateur/reinitialiser' && requete.method === 'POST') {
    demandes.clear();
    return repondre(reponse, 200, { message: 'Simulateur réinitialisé.' });
  }

  if (url.pathname === '/api/v1/sante') {
    return repondre(reponse, 200, { statut: 'ok', demandes: demandes.size });
  }

  if (chaos.panne) {
    requete.socket.destroy();
    return;
  }
  if (chaos.latenceMs > 0) await attendre(chaos.latenceMs);

  if (Math.random() < chaos.tauxErreur) {
    return repondre(reponse, 503, {
      code: 'SERVICE_INDISPONIBLE',
      message: 'Le service de paiement est momentanément indisponible.',
    });
  }

  if (url.pathname === '/api/v1/paiements' && requete.method === 'POST') {
    return creerDemande(requete, reponse);
  }

  const confirmation = url.pathname.match(/^\/api\/v1\/paiements\/([^/]+)\/confirmer$/);
  if (confirmation && requete.method === 'POST') {
    return confirmerPaiement(requete, reponse, decodeURIComponent(confirmation[1]));
  }

  const consultation = url.pathname.match(/^\/api\/v1\/paiements\/([^/]+)$/);
  if (consultation && requete.method === 'GET') {
    const demande = demandes.get(decodeURIComponent(consultation[1]));
    if (!demande) return repondre(reponse, 404, { code: 'INTROUVABLE' });
    return repondre(reponse, 200, vueDemande(demande));
  }

  return repondre(reponse, 404, { code: 'ROUTE_INCONNUE', message: 'Route inconnue.' });
});

serveur.listen(PORT, () => {
  console.log(`[momo-sim] Simulateur mobile money à l'écoute sur http://localhost:${PORT}`);
  console.log('[momo-sim] Confirmer un paiement : POST /api/v1/paiements/:reference/confirmer');
  console.log('[momo-sim] Panneau de contrôle    : POST /_simulateur/config');
});

export { serveur, chaos, SECRET };
