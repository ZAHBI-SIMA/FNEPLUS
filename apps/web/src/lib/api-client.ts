/**
 * Client HTTP vers l'API FNE+.
 *
 * Utilisé depuis le worker. Deux partis pris qui comptent sur un réseau mobile
 * ivoirien :
 *
 *  - **Un délai d'attente court et explicite.** Sans `AbortController`, une
 *    requête sur une 3G qui ne répond plus reste pendante plusieurs minutes, et
 *    l'outbox se bloque derrière. Mieux vaut échouer vite et réessayer.
 *  - **Aucune distinction entre « hors ligne » et « serveur injoignable ».**
 *    Pour l'appelant, les deux se traitent pareil : on réessaiera. Seules les
 *    réponses effectivement reçues du serveur changent l'état des commandes.
 */

const DELAI_ATTENTE_MS = 20_000;

export class ErreurReseau extends Error {
  constructor(message = 'Serveur injoignable.') {
    super(message);
    this.name = 'ErreurReseau';
  }
}

export class ErreurApi extends Error {
  constructor(
    readonly statut: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ErreurApi';
  }

  /** Une erreur d'authentification ne se réessaie pas : il faut se reconnecter. */
  get exigeReconnexion(): boolean {
    return this.statut === 401;
  }
}

export interface OptionsAppel {
  methode?: 'GET' | 'POST';
  corps?: unknown;
  jeton?: string;
  baseUrl?: string;
}

/** Origine de l'API. En développement, l'API tourne sur un autre port. */
export function urlApi(): string {
  if (typeof location !== 'undefined' && location.hostname === 'localhost') {
    return 'http://localhost:4001';
  }
  return typeof location !== 'undefined' ? location.origin : '';
}

export async function appelerApi<T>(chemin: string, options: OptionsAppel = {}): Promise<T> {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_ATTENTE_MS);

  let reponse: Response;
  try {
    reponse = await fetch(`${options.baseUrl ?? urlApi()}${chemin}`, {
      method: options.methode ?? 'GET',
      headers: {
        ...(options.corps !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.jeton ? { Authorization: `Bearer ${options.jeton}` } : {}),
      },
      ...(options.corps !== undefined ? { body: JSON.stringify(options.corps) } : {}),
      signal: controleur.signal,
    });
  } catch {
    throw new ErreurReseau();
  } finally {
    clearTimeout(minuteur);
  }

  const texte = await reponse.text();
  const donnees = texte ? (JSON.parse(texte) as Record<string, unknown>) : null;

  if (!reponse.ok) {
    throw new ErreurApi(
      reponse.status,
      (donnees?.['message'] as string) ?? 'Le serveur a refusé la demande.',
      donnees?.['code'] as string | undefined,
    );
  }

  return donnees as T;
}
