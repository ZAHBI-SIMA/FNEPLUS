/**
 * Client HTTP vers l'API FNE de la DGI.
 *
 * Seul module du produit qui parle réellement à l'administration. Il ne connaît
 * rien du métier : il envoie ce que la couche d'anticorruption lui donne et rend
 * ce qu'il reçoit.
 *
 * Tant que l'accès au bac à sable officiel n'est pas acquis, il pointe sur le
 * simulateur (`apps/dgi-sim`), qui permet d'éprouver la file, le rejeu et le
 * disjoncteur contre des pannes provoquées.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { JETON_CONFIG } from '../db/db.module.js';
import type { Configuration } from '../config.js';
import type { FactureDGI, ReponseDGI } from './anticorruption.js';

/** Échec réseau ou serveur : il compte pour le disjoncteur et se réessaie. */
export class ErreurTransportDGI extends Error {
  constructor(
    message: string,
    readonly statut?: number,
  ) {
    super(message);
    this.name = 'ErreurTransportDGI';
  }
}

@Injectable()
export class DgiClient {
  private readonly logger = new Logger(DgiClient.name);

  constructor(@Inject(JETON_CONFIG) private readonly config: Configuration) {}

  /**
   * Transmet une facture.
   *
   * La clé d'idempotence est l'identifiant de la facture : si un envoi part mais
   * que la réponse se perd, le rejeu ne crée pas de doublon côté DGI. C'est
   * exactement ce qui arrive quand la connexion coupe au mauvais moment.
   */
  async transmettre(facture: FactureDGI): Promise<ReponseDGI> {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.config.DGI_DELAI_ATTENTE_MS);

    let reponse: Response;
    try {
      reponse = await fetch(`${this.config.DGI_URL}/api/v1/factures`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': facture.id,
          ...(this.config.DGI_CLE_API
            ? { Authorization: `Bearer ${this.config.DGI_CLE_API}` }
            : {}),
        },
        body: JSON.stringify({ facture }),
        signal: controleur.signal,
      });
    } catch (erreur) {
      // Injoignable, DNS en échec, délai dépassé : le service est en cause, pas
      // la facture. Le disjoncteur doit le compter.
      throw new ErreurTransportDGI(
        erreur instanceof Error && erreur.name === 'AbortError'
          ? 'Le service de la DGI n’a pas répondu dans le délai imparti.'
          : 'Service de la DGI injoignable.',
      );
    } finally {
      clearTimeout(minuteur);
    }

    const texte = await reponse.text();
    const corps = texte ? (JSON.parse(texte) as Record<string, unknown>) : {};

    // 5xx et 429 : problème côté service. On réessaiera, et ça compte pour le
    // disjoncteur.
    if (reponse.status >= 500 || reponse.status === 429) {
      throw new ErreurTransportDGI(
        (corps['message'] as string) ?? `La DGI a répondu ${reponse.status}.`,
        reponse.status,
      );
    }

    // 4xx métier : le service fonctionne, c'est la facture qui est refusée.
    // Surtout ne pas ouvrir le disjoncteur pour ça.
    if (reponse.status === 422 || reponse.status === 400) {
      return {
        statut: 'REJETEE',
        motifs: (corps['motifs'] as string[]) ?? [
          (corps['message'] as string) ?? 'Refus sans motif.',
        ],
      };
    }

    if (!reponse.ok) {
      throw new ErreurTransportDGI(
        `Réponse inattendue de la DGI (${reponse.status}).`,
        reponse.status,
      );
    }

    return {
      statut: 'CERTIFIEE',
      identifiantCertification: corps['identifiantCertification'] as string,
      horodatageCertifie: corps['horodatageCertifie'] as string,
      contenuQR: corps['contenuQR'] as string,
    };
  }

  /** Sonde de disponibilité, utilisée par la supervision. */
  async sante(): Promise<boolean> {
    try {
      const reponse = await fetch(`${this.config.DGI_URL}/api/v1/sante`, {
        signal: AbortSignal.timeout(5_000),
      });
      return reponse.ok;
    } catch {
      return false;
    }
  }
}
