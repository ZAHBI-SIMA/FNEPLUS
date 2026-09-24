/**
 * Garde d'authentification et contexte de session.
 *
 * Le jeton porte l'entreprise : c'est lui, et jamais un paramètre de requête,
 * qui détermine le contexte tenant posé en base. Un client ne peut donc pas lire
 * les données d'un autre en changeant un identifiant dans l'URL — la tentative
 * ne rencontre même pas de vérification applicative, elle rencontre la RLS.
 */

import {
  CanActivate,
  createParamDecorator,
  Inject,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

export type RoleUtilisateur = 'PROPRIETAIRE' | 'CAISSIER' | 'COMPTABLE';

export interface Session {
  utilisateurId: string;
  entrepriseId: string;
  role: RoleUtilisateur;
  nom: string;
  terminalId?: string;
}

export const CLE_PUBLIQUE = 'route_publique';
/** Marque une route accessible sans jeton (inscription, demande de code). */
export const Publique = () => SetMetadata(CLE_PUBLIQUE, true);

export const CLE_ROLES = 'roles_autorises';
export const Roles = (...roles: RoleUtilisateur[]) => SetMetadata(CLE_ROLES, roles);

export const SessionCourante = createParamDecorator(
  (_donnees: unknown, contexte: ExecutionContext): Session => {
    const requete = contexte.switchToHttp().getRequest<{ session?: Session }>();
    if (!requete.session) {
      throw new UnauthorizedException({
        code: 'NON_AUTHENTIFIE',
        message: 'Connectez-vous pour continuer.',
      });
    }
    return requete.session;
  },
);

@Injectable()
export class GardeAuth implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(contexte: ExecutionContext): Promise<boolean> {
    const estPublique = this.reflector.getAllAndOverride<boolean>(CLE_PUBLIQUE, [
      contexte.getHandler(),
      contexte.getClass(),
    ]);
    if (estPublique) return true;

    const requete = contexte.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      session?: Session;
    }>();

    const entete = requete.headers['authorization'];
    if (!entete?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'NON_AUTHENTIFIE',
        message: 'Connectez-vous pour continuer.',
      });
    }

    try {
      requete.session = await this.jwt.verifyAsync<Session>(entete.slice(7));
    } catch {
      throw new UnauthorizedException({
        code: 'SESSION_EXPIREE',
        message: 'Votre session a expiré. Reconnectez-vous.',
      });
    }

    const rolesAutorises = this.reflector.getAllAndOverride<RoleUtilisateur[]>(CLE_ROLES, [
      contexte.getHandler(),
      contexte.getClass(),
    ]);

    if (rolesAutorises?.length && !rolesAutorises.includes(requete.session.role)) {
      throw new ForbiddenException({
        code: 'DROITS_INSUFFISANTS',
        message: 'Votre rôle ne permet pas cette action.',
      });
    }

    return true;
  }
}
