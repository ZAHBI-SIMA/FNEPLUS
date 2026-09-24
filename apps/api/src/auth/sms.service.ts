/**
 * Envoi de SMS.
 *
 * Abstraction volontairement posée dès maintenant, alors qu'aucun opérateur
 * n'est encore intégré : le choix entre agrégateur et intégration directe fait
 * partie des points à confirmer (cf. plan de développement). L'implémentation
 * `console` permet de développer et de tester tout le parcours de connexion sans
 * attendre cette décision.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { JETON_CONFIG } from '../db/db.module.js';
import type { Configuration } from '../config.js';

export interface MessageSms {
  destinataire: string;
  contenu: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  /** Messages envoyés, conservés en mémoire pour les tests d'intégration. */
  readonly envoyes: MessageSms[] = [];

  constructor(@Inject(JETON_CONFIG) private readonly config: Configuration) {}

  async envoyer(destinataire: string, contenu: string): Promise<void> {
    switch (this.config.SMS_FOURNISSEUR) {
      case 'console':
        this.envoyes.push({ destinataire, contenu });
        this.logger.log(`SMS → ${destinataire} : ${contenu}`);
        return;

      case 'orange':
      case 'mtn':
        // À implémenter une fois le fournisseur retenu et le contrat signé.
        throw new Error(`Fournisseur SMS « ${this.config.SMS_FOURNISSEUR} » pas encore intégré.`);
    }
  }
}
