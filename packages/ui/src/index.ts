/**
 * @fneplus/ui — design system FNE+.
 *
 * Volontairement sans dépendance d'interface tierce : chaque kilo-octet de
 * JavaScript se paie en données mobiles chez l'utilisateur final. Les composants
 * sont de fines enveloppes autour de classes CSS, importées globalement par
 * l'application.
 */

export { Bouton, type ProprietesBouton } from './composants/Bouton';
export { Carte, type ProprietesCarte } from './composants/Carte';
export { Badge, type ProprietesBadge, type TonBadge } from './composants/Badge';
export { BandeauReseau, type ProprietesBandeauReseau } from './composants/BandeauReseau';
export { LigneInfo, type ProprietesLigneInfo } from './composants/LigneInfo';
export { Alerte, type ProprietesAlerte } from './composants/Alerte';
export { tonPourStatutFacture, libelleStatutFacture } from './statuts';
