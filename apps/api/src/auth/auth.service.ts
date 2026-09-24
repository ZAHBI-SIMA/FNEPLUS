/**
 * Authentification.
 *
 * Parcours retenu : le numéro de téléphone est l'identifiant, un code OTP à
 * 6 chiffres établit la première session, et un code PIN prend le relais pour
 * les connexions suivantes sur le même appareil.
 *
 * Pourquoi pas un mot de passe : saisir un mot de passe long sur un clavier de
 * smartphone d'entrée de gamme, debout, avec un client qui attend, ne se fait
 * pas. Le PIN protège une caisse, pas un compte bancaire, et le SMS reste le
 * canal de récupération universel — y compris pour un commerçant sans adresse
 * e-mail.
 */

import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { uuidv7 } from '@fneplus/core';
import { BaseDeDonnees, JETON_CONFIG, type TransactionSql } from '../db/db.module.js';
import type { Configuration } from '../config.js';
import type { RoleUtilisateur, Session } from '../commun/auth.garde.js';
import { genererCodeOtp, hacher, verifier } from './secrets.js';
import { SmsService } from './sms.service.js';

/** Durée de validité d'un code OTP. */
const DUREE_OTP_MS = 5 * 60 * 1000;
/** Nombre de vérifications échouées avant invalidation du code. */
const MAX_TENTATIVES_OTP = 5;
/** Fenêtre et quota de demandes de code, par numéro. */
const FENETRE_DEMANDES_MS = 15 * 60 * 1000;
const MAX_DEMANDES = 3;

interface CompteResolu {
  utilisateur_id: string;
  entreprise_id: string;
  role: RoleUtilisateur;
  nom: string;
  a_un_pin: boolean;
}

export interface ResultatConnexion {
  jeton: string;
  session: Omit<Session, 'terminalId'>;
  /** Vrai si l'utilisateur n'a pas encore défini de code PIN. */
  definirPin: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(SmsService) private readonly sms: SmsService,
    @Inject(JETON_CONFIG) private readonly config: Configuration,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Code OTP                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Envoie un code de connexion.
   *
   * La réponse ne dit jamais si le numéro correspond à un compte existant :
   * l'API deviendrait sinon un outil d'énumération des commerçants inscrits.
   */
  async demanderCode(telephone: string): Promise<void> {
    await this.bdd.horsTenant(async (tx) => {
      const depuis = new Date(Date.now() - FENETRE_DEMANDES_MS);
      const [recentes] = await tx<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM codes_otp
         WHERE telephone = ${telephone} AND cree_le > ${depuis}
      `;

      if ((recentes?.n ?? 0) >= MAX_DEMANDES) {
        throw new HttpException(
          {
            code: 'TROP_DE_DEMANDES',
            message: 'Trop de codes demandés. Patientez quelques minutes avant de réessayer.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const compte = await this.resoudreCompte(tx, telephone);
      // Pas de compte : on s'arrête ici, sans le dire et sans envoyer de SMS.
      if (!compte) return;

      const code = genererCodeOtp();

      // Les codes précédents sont invalidés : deux codes valides en même temps
      // doublent la surface d'attaque sans rien apporter à l'utilisateur.
      await tx`
        UPDATE codes_otp SET consomme_le = now()
         WHERE telephone = ${telephone} AND consomme_le IS NULL
      `;

      await tx`
        INSERT INTO codes_otp (id, telephone, code_hash, expire_le)
        VALUES (${uuidv7()}, ${telephone}, ${await hacher(code)},
                ${new Date(Date.now() + DUREE_OTP_MS)})
      `;

      await this.sms.envoyer(
        telephone,
        `FNE+ : votre code de connexion est ${code}. Il expire dans 5 minutes. Ne le communiquez à personne.`,
      );
    });
  }

  async verifierCode(telephone: string, code: string): Promise<ResultatConnexion> {
    return this.bdd.horsTenant(async (tx) => {
      const [enregistre] = await tx<{ id: string; code_hash: string; tentatives: number }[]>`
        SELECT id, code_hash, tentatives FROM codes_otp
         WHERE telephone = ${telephone}
           AND consomme_le IS NULL
           AND expire_le > now()
         ORDER BY cree_le DESC
         LIMIT 1
      `;

      if (!enregistre || enregistre.tentatives >= MAX_TENTATIVES_OTP) {
        throw new UnauthorizedException({
          code: 'CODE_INVALIDE',
          message: 'Code incorrect ou expiré. Demandez un nouveau code.',
        });
      }

      if (!(await verifier(code, enregistre.code_hash))) {
        await tx`UPDATE codes_otp SET tentatives = tentatives + 1 WHERE id = ${enregistre.id}`;
        throw new UnauthorizedException({
          code: 'CODE_INVALIDE',
          message: 'Code incorrect ou expiré. Demandez un nouveau code.',
        });
      }

      // Le code est consommé dans la même transaction que sa vérification :
      // deux requêtes simultanées avec le même code ne peuvent pas réussir
      // toutes les deux.
      await tx`UPDATE codes_otp SET consomme_le = now() WHERE id = ${enregistre.id}`;

      const compte = await this.resoudreCompte(tx, telephone);
      if (!compte) {
        throw new UnauthorizedException({
          code: 'COMPTE_INTROUVABLE',
          message: 'Aucun compte actif pour ce numéro.',
        });
      }

      return this.ouvrirSession(compte);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Code PIN                                                            */
  /* ------------------------------------------------------------------ */

  async definirPin(session: Session, pin: string): Promise<void> {
    const empreinte = await hacher(pin);
    await this.bdd.avecTenant(session.entrepriseId, async (tx) => {
      await tx`UPDATE utilisateurs SET pin_hash = ${empreinte} WHERE id = ${session.utilisateurId}`;
    });
  }

  async connecterParPin(telephone: string, pin: string): Promise<ResultatConnexion> {
    return this.bdd.horsTenant(async (tx) => {
      const compte = await this.resoudreCompte(tx, telephone);

      // Message identique que le compte existe ou non, et que le PIN soit
      // défini ou non : sinon la réponse révèle quels numéros sont inscrits.
      const refus = new UnauthorizedException({
        code: 'IDENTIFIANTS_INVALIDES',
        message: 'Numéro ou code incorrect.',
      });

      if (!compte?.a_un_pin) throw refus;

      // L'entreprise est connue à partir d'ici : on pose le contexte tenant
      // avant de lire `utilisateurs`, table soumise à la RLS. Sans cette ligne,
      // la requête ne renverrait rien et toute connexion par PIN échouerait.
      await tx`SELECT set_config('fneplus.entreprise_id', ${compte.entreprise_id}, true)`;

      const [ligne] = await tx<{ pin_hash: string }[]>`
        SELECT pin_hash FROM utilisateurs WHERE id = ${compte.utilisateur_id}
      `;
      if (!ligne?.pin_hash || !(await verifier(pin, ligne.pin_hash))) throw refus;

      return this.ouvrirSession(compte);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Interne                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Résolution du compte par téléphone.
   *
   * Passe par la fonction SECURITY DEFINER dédiée : à cet instant on n'a pas
   * encore d'entreprise, donc la RLS bloquerait une lecture directe de
   * `utilisateurs`. Voir la migration 002.
   */
  private async resoudreCompte(
    tx: TransactionSql,
    telephone: string,
  ): Promise<CompteResolu | null> {
    const lignes = await tx<CompteResolu[]>`
      SELECT * FROM fneplus_resoudre_compte(${telephone})
    `;
    return lignes[0] ?? null;
  }

  private async ouvrirSession(compte: CompteResolu): Promise<ResultatConnexion> {
    const session: Omit<Session, 'terminalId'> = {
      utilisateurId: compte.utilisateur_id,
      entrepriseId: compte.entreprise_id,
      role: compte.role,
      nom: compte.nom,
    };

    return {
      jeton: await this.jwt.signAsync(session, { expiresIn: this.config.JWT_DUREE_SECONDES }),
      session,
      definirPin: !compte.a_un_pin,
    };
  }
}
