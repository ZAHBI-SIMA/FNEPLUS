/**
 * @fneplus/core — noyau de domaine partagé entre la PWA et l'API.
 *
 * Règle : toute logique qui doit produire le même résultat hors ligne et en
 * ligne vit dans ce package. Rien ici ne dépend du navigateur ni de Node.
 */

export * from './ids.js';
export * from './money.js';
export * from './types.js';
export * from './tax/referentiel.js';
export * from './tax/engine.js';
export * from './numbering/plage.js';
export * from './integrity/chaine.js';
export * from './clock/hlc.js';
export * from './sync/commandes.js';
export * from './qr/contenu.js';
