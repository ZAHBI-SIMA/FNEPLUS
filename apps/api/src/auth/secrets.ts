/**
 * Hachage des secrets courts (code OTP, code PIN).
 *
 * scrypt de la bibliothèque standard Node : pas de dépendance native à compiler,
 * et un coût de calcul paramétrable. C'est indispensable ici parce que l'espace
 * de recherche est minuscule — un PIN à 4 chiffres, c'est 10 000 possibilités.
 * Un SHA-256 se cassera en quelques millisecondes ; un scrypt correctement
 * paramétré rend l'attaque hors ligne coûteuse.
 *
 * La comparaison est à temps constant : comparer deux chaînes avec `===` fuite
 * la position du premier caractère différent.
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * `promisify` ne sait pas choisir la surcharge de `scrypt` qui accepte des
 * options, et retomberait sur les paramètres par défaut — beaucoup trop faibles
 * pour un secret de 4 chiffres. On enveloppe donc l'appel à la main.
 */
function scryptAsync(
  secret: string,
  sel: Buffer,
  longueur: number,
  options: ParametresScrypt,
): Promise<Buffer> {
  return new Promise((resoudre, rejeter) => {
    scrypt(secret, sel, longueur, options, (erreur, cle) =>
      erreur ? rejeter(erreur) : resoudre(cle),
    );
  });
}

interface ParametresScrypt {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

const LONGUEUR_CLE = 32;
const LONGUEUR_SEL = 16;
// N=2^15 : environ 100 ms sur un serveur modeste. Assez lent pour dissuader
// une attaque par force brute, assez rapide pour ne pas gêner une connexion.
const PARAMETRES: ParametresScrypt = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hacher(secret: string): Promise<string> {
  const sel = randomBytes(LONGUEUR_SEL);
  const cle = await scryptAsync(secret, sel, LONGUEUR_CLE, PARAMETRES);
  return `scrypt$${sel.toString('base64')}$${cle.toString('base64')}`;
}

export async function verifier(secret: string, empreinte: string): Promise<boolean> {
  const [algo, selB64, cleB64] = empreinte.split('$');
  if (algo !== 'scrypt' || !selB64 || !cleB64) return false;

  const sel = Buffer.from(selB64, 'base64');
  const attendue = Buffer.from(cleB64, 'base64');
  const calculee = await scryptAsync(secret, sel, attendue.length, PARAMETRES);

  return calculee.length === attendue.length && timingSafeEqual(calculee, attendue);
}

/**
 * Code OTP à 6 chiffres.
 *
 * `randomInt` et non `Math.random` : un code de connexion prédictible permet de
 * prendre la main sur le compte d'un commerçant.
 */
export function genererCodeOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
