/**
 * Identifiants UUIDv7.
 *
 * Générés sur l'appareil, hors ligne, et utilisés directement comme clé
 * primaire : l'application ne demande jamais d'identifiant au serveur, sinon
 * rien ne serait créable sans réseau.
 *
 * UUIDv7 plutôt que v4 parce qu'il est ordonné par le temps : les insertions
 * restent séquentielles dans l'index (moins de fragmentation côté SQLite comme
 * côté PostgreSQL), et un tri par identifiant redonne l'ordre de création.
 *
 * Sert aussi de clé d'idempotence pour l'outbox : rejouer un lot déjà appliqué
 * n'a aucun effet côté serveur.
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function uuidv7(maintenant: number = Date.now()): string {
  const octets = new Uint8Array(16);
  globalThis.crypto.getRandomValues(octets);

  // 48 bits d'horodatage en millisecondes, en tête.
  octets[0] = (maintenant / 2 ** 40) & 0xff;
  octets[1] = (maintenant / 2 ** 32) & 0xff;
  octets[2] = (maintenant / 2 ** 24) & 0xff;
  octets[3] = (maintenant / 2 ** 16) & 0xff;
  octets[4] = (maintenant / 2 ** 8) & 0xff;
  octets[5] = maintenant & 0xff;

  // Version 7 et variante RFC 4122.
  octets[6] = (octets[6]! & 0x0f) | 0x70;
  octets[8] = (octets[8]! & 0x3f) | 0x80;

  const h = (i: number) => HEX[octets[i]!]!;
  return (
    h(0) +
    h(1) +
    h(2) +
    h(3) +
    '-' +
    h(4) +
    h(5) +
    '-' +
    h(6) +
    h(7) +
    '-' +
    h(8) +
    h(9) +
    '-' +
    h(10) +
    h(11) +
    h(12) +
    h(13) +
    h(14) +
    h(15)
  );
}

/** Extrait l'instant de création encodé dans un UUIDv7. */
export function instantUuidv7(uuid: string): number {
  const hex = uuid.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}
