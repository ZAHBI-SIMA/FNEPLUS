/**
 * Implémentation du prestataire de paiement sur un agrégateur.
 *
 * Elle pointe par défaut sur le simulateur local (`apps/momo-sim`), qui imite le
 * fonctionnement commun aux agrégateurs du marché ivoirien : création d'une
 * demande, lien à présenter au client, confirmation par webhook signé.
 *
 * Le jour où l'agrégateur réel est retenu, seul ce fichier change.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JETON_CONFIG } from '../db/db.module.js';
import type { Configuration } from '../config.js';
import {
  ErreurPrestataire,
  type DemandePaiement,
  type NotificationPaiement,
  type Operateur,
  type PaiementCree,
  type PrestatairePaiement,
  type StatutPaiement,
} from './prestataire.js';

@Injectable()
export class AgregateurClient implements PrestatairePaiement {
  private readonly logger = new Logger(AgregateurClient.name);

  constructor(@Inject(JETON_CONFIG) private readonly config: Configuration) {}

  async creerDemande(demande: DemandePaiement): Promise<PaiementCree> {
    const reponse = await this.appeler('/api/v1/paiements', {
      methode: 'POST',
      corps: {
        referenceExterne: demande.referenceExterne,
        montant: demande.montant,
        operateur: demande.operateur,
        ...(demande.telephone ? { telephone: demande.telephone } : {}),
        urlWebhook: demande.urlWebhook,
      },
    });

    return this.versPaiementCree(reponse);
  }

  async consulter(reference: string): Promise<PaiementCree> {
    return this.versPaiementCree(await this.appeler(`/api/v1/paiements/${reference}`));
  }

  /**
   * Vérifie la signature d'une notification.
   *
   * Comparaison à temps constant : comparer deux signatures avec `===` fuite la
   * position du premier caractère différent, ce qui permet de la reconstituer
   * caractère par caractère.
   */
  verifierSignature(corpsBrut: string, signature: string | undefined): boolean {
    if (!signature) return false;

    const attendue = createHmac('sha256', this.config.MOMO_SECRET).update(corpsBrut).digest('hex');

    const a = Buffer.from(attendue, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  lireNotification(corps: unknown): NotificationPaiement | null {
    if (!corps || typeof corps !== 'object') return null;
    const c = corps as Record<string, unknown>;

    if (typeof c['reference'] !== 'string' || typeof c['referenceExterne'] !== 'string') {
      return null;
    }

    return {
      reference: c['reference'],
      referenceExterne: c['referenceExterne'],
      statut: this.versStatut(c['statut']),
      montant: Number(c['montant'] ?? 0),
      operateur: c['operateur'] as Operateur,
      ...(typeof c['regleLe'] === 'string' ? { regleLe: c['regleLe'] } : {}),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Interne                                                             */
  /* ------------------------------------------------------------------ */

  private async appeler(
    chemin: string,
    options: { methode?: 'GET' | 'POST'; corps?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    let reponse: Response;

    try {
      reponse = await fetch(`${this.config.MOMO_URL}${chemin}`, {
        method: options.methode ?? 'GET',
        headers: {
          ...(options.corps !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.config.MOMO_CLE_API
            ? { Authorization: `Bearer ${this.config.MOMO_CLE_API}` }
            : {}),
        },
        ...(options.corps !== undefined ? { body: JSON.stringify(options.corps) } : {}),
        signal: AbortSignal.timeout(this.config.MOMO_DELAI_ATTENTE_MS),
      });
    } catch {
      // Service injoignable : le commerçant peut encaisser en espèces, et
      // réessayer plus tard. C'est réessayable.
      throw new ErreurPrestataire('Service de paiement injoignable.', true);
    }

    const texte = await reponse.text();
    const corps = texte ? (JSON.parse(texte) as Record<string, unknown>) : {};

    if (reponse.status >= 500 || reponse.status === 429) {
      throw new ErreurPrestataire(
        (corps['message'] as string) ?? 'Service de paiement momentanément indisponible.',
        true,
      );
    }

    if (reponse.status === 422 || reponse.status === 400) {
      const motifs = (corps['motifs'] as string[]) ?? [
        (corps['message'] as string) ?? 'Demande refusée.',
      ];
      throw new ErreurPrestataire(motifs.join(' ; '), false);
    }

    if (!reponse.ok) {
      throw new ErreurPrestataire(`Réponse inattendue du prestataire (${reponse.status}).`, true);
    }

    return corps;
  }

  private versPaiementCree(corps: Record<string, unknown>): PaiementCree {
    return {
      reference: corps['reference'] as string,
      referenceExterne: corps['referenceExterne'] as string,
      montant: Number(corps['montant']),
      operateur: corps['operateur'] as Operateur,
      statut: this.versStatut(corps['statut']),
      lienPaiement: corps['lienPaiement'] as string,
    };
  }

  /**
   * Normalise les statuts.
   *
   * Chaque opérateur a son vocabulaire : `SUCCESS`, `COMPLETED`, `PAID`,
   * `ACCEPTED`… Toute cette diversité s'arrête ici. Un statut inconnu est traité
   * comme « en attente » plutôt que comme un règlement : dans le doute, on ne
   * déclare jamais une facture payée.
   */
  private versStatut(valeur: unknown): StatutPaiement {
    const brut = String(valeur ?? '').toUpperCase();

    if (['REGLEE', 'SUCCESS', 'COMPLETED', 'PAID', 'SUCCESSFUL'].includes(brut)) return 'REGLEE';
    if (['ABANDONNEE', 'CANCELLED', 'EXPIRED', 'TIMEOUT'].includes(brut)) return 'ABANDONNEE';
    if (['REFUSEE', 'FAILED', 'DECLINED', 'REJECTED'].includes(brut)) return 'REFUSEE';

    if (brut !== 'EN_ATTENTE' && brut !== 'PENDING') {
      this.logger.warn(`Statut de paiement inconnu « ${brut} » : traité comme en attente.`);
    }
    return 'EN_ATTENTE';
  }
}
