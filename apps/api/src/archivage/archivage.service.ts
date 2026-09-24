/**
 * Archivage légal et export de contrôle fiscal.
 *
 * Trois responsabilités :
 *
 *  1. **Vérifier la chaîne d'intégrité.** Chaque facture porte l'empreinte de la
 *     précédente. Rejouer la chaîne prouve qu'aucune facture n'a été supprimée
 *     ni modifiée après coup — c'est ce qui rend l'archivage « infalsifiable ».
 *
 *  2. **Sceller des périodes.** Un scellé fige l'état d'un ensemble de factures
 *     à un instant donné. Sans lui, la chaîne prouve la cohérence interne mais
 *     pas l'antériorité : rien n'empêcherait de reconstruire une chaîne entière
 *     après coup.
 *
 *  3. **Produire un export de contrôle**, vérifiable de bout en bout par un
 *     agent qui ne fait confiance ni à nous, ni au contribuable.
 *
 * ⚠️ L'horodatage est pour l'instant produit par le serveur et explicitement
 * marqué NON QUALIFIÉ. Un horodatage opposable exige une autorité tierce
 * (RFC 3161) : c'est un contrat à passer, pas une ligne de code. Tant que ce
 * n'est pas fait, un scellé prouve l'intégrité, pas la date.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { canoniser, verifierChaine, type Facture } from '@fneplus/core';
import { BaseDeDonnees, JETON_CONFIG } from '../db/db.module.js';
import type { Configuration } from '../config.js';

export interface ResultatVerificationChaine {
  valide: boolean;
  nombreFactures: number;
  anomalies: { numero: string; type: string; detail: string }[];
  premiereFacture?: string;
  derniereFacture?: string;
}

export interface Scelle {
  id: string;
  periodeDebut: string;
  periodeFin: string;
  nombreFactures: number;
  premiereFacture: string;
  derniereFacture: string;
  empreinteFinale: string;
  empreinteScelle: string;
  horodatageQualifie: boolean;
  scelleLe: string;
}

export interface ExportControle {
  id: string;
  genereLe: string;
  entreprise: { ncc: string; raisonSociale: string; regimeFiscal: string };
  periode: { debut: string; fin: string };
  nombreFactures: number;
  chaineValide: boolean;
  anomalies: ResultatVerificationChaine['anomalies'];
  totaux: { totalHT: number; totalTVA: number; totalTTC: number };
  factures: Record<string, unknown>[];
  empreinteExport: string;
  /**
   * Instructions de vérification, incluses dans l'export.
   *
   * Un agent doit pouvoir contrôler sans nous croire sur parole ni disposer de
   * notre outillage.
   */
  commentVerifier: string[];
}

const INSTRUCTIONS_VERIFICATION = [
  'Chaque facture porte le champ « empreinte » et le champ « empreintePrecedente ».',
  'L’empreinte est un SHA-256 de la facture sérialisée en JSON canonique (clés triées, sans espace), limité aux champs listés dans « champsEmpreinte ».',
  'L’empreinte de la première facture de la chaîne référence 64 zéros.',
  'Pour chaque facture suivante, « empreintePrecedente » doit être égale à l’« empreinte » de la facture qui la précède dans l’ordre d’émission.',
  'Une rupture de cette suite signale une facture supprimée, insérée ou modifiée après émission.',
  'L’empreinte de l’export couvre l’ensemble des factures listées : la recalculer permet de vérifier que le fichier n’a pas été modifié depuis sa production.',
];

@Injectable()
export class ArchivageService {
  private readonly logger = new Logger(ArchivageService.name);

  constructor(
    @Inject(BaseDeDonnees) private readonly bdd: BaseDeDonnees,
    @Inject(JETON_CONFIG) private readonly config: Configuration,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Vérification de chaîne                                              */
  /* ------------------------------------------------------------------ */

  async verifier(
    entrepriseId: string,
    periode?: { debut?: string; fin?: string },
  ): Promise<ResultatVerificationChaine> {
    const factures = await this.chargerFactures(entrepriseId, periode);

    if (factures.length === 0) {
      return { valide: true, nombreFactures: 0, anomalies: [] };
    }

    // La vérification utilise le MÊME code que celui qui a produit les
    // empreintes sur le terminal (`@fneplus/core`). Une divergence entre les
    // deux rendrait la vérification sans valeur.
    const resultat = await verifierChaine(factures);

    return {
      valide: resultat.valide,
      nombreFactures: factures.length,
      anomalies: resultat.anomalies.map((a) => ({
        numero: a.numero,
        type: a.type,
        detail: a.detail,
      })),
      premiereFacture: factures[0]!.numero,
      derniereFacture: factures.at(-1)!.numero,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Scellés                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Scelle une période.
   *
   * Un scellé n'est posé que si la chaîne est valide : sceller une chaîne rompue
   * reviendrait à certifier une incohérence.
   */
  async sceller(
    entrepriseId: string,
    periode: { debut: string; fin: string },
  ): Promise<Scelle | { refus: string; anomalies: ResultatVerificationChaine['anomalies'] }> {
    const verification = await this.verifier(entrepriseId, periode);

    if (verification.nombreFactures === 0) {
      return { refus: 'Aucune facture sur cette période.', anomalies: [] };
    }
    if (!verification.valide) {
      return {
        refus:
          'La chaîne d’intégrité présente des anomalies : la période ne peut pas être scellée en l’état.',
        anomalies: verification.anomalies,
      };
    }

    const factures = await this.chargerFactures(entrepriseId, periode);
    const empreinteFinale = factures.at(-1)!.hash;

    const contenu = canoniser({
      entrepriseId,
      periode,
      nombreFactures: factures.length,
      premiere: factures[0]!.numero,
      derniere: factures.at(-1)!.numero,
      empreinteFinale,
    });

    const empreinteScelle = this.signer(contenu);
    const id = randomUUID();
    const scelleLe = new Date().toISOString();

    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        INSERT INTO scelles_archivage (
          id, entreprise_id, periode_debut, periode_fin, nombre_factures,
          premiere_facture, derniere_facture, empreinte_finale, empreinte_scelle,
          jeton_horodatage, horodatage_qualifie, scelle_le
        ) VALUES (
          ${id}, ${entrepriseId}, ${periode.debut}, ${periode.fin}, ${factures.length},
          ${factures[0]!.numero}, ${factures.at(-1)!.numero}, ${empreinteFinale},
          ${empreinteScelle}, ${empreinteScelle}, ${false}, ${scelleLe}
        )
      `;
    });

    this.logger.log(
      `Période scellée pour ${entrepriseId} : ${factures.length} factures, ${factures[0]!.numero} → ${factures.at(-1)!.numero}`,
    );

    return {
      id,
      periodeDebut: periode.debut,
      periodeFin: periode.fin,
      nombreFactures: factures.length,
      premiereFacture: factures[0]!.numero,
      derniereFacture: factures.at(-1)!.numero,
      empreinteFinale,
      empreinteScelle,
      // Faux tant qu'une autorité d'horodatage qualifiée n'est pas contractée.
      horodatageQualifie: false,
      scelleLe,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Export de contrôle                                                  */
  /* ------------------------------------------------------------------ */

  async exporter(
    entrepriseId: string,
    periode: { debut: string; fin: string },
    demande: { parUtilisateur?: string; motif?: string } = {},
  ): Promise<ExportControle> {
    const factures = await this.chargerFactures(entrepriseId, periode);
    const verification = await this.verifier(entrepriseId, periode);

    const entreprise = await this.bdd.avecTenant(entrepriseId, async (tx) => {
      const [e] = await tx<{ ncc: string; raison_sociale: string; regime_fiscal: string }[]>`
        SELECT ncc, raison_sociale, regime_fiscal FROM entreprises WHERE id = ${entrepriseId}
      `;
      return e;
    });

    const totaux = factures.reduce(
      (acc, f) => ({
        totalHT: acc.totalHT + f.totaux.totalHT,
        totalTVA: acc.totalTVA + f.totaux.totalTVA,
        totalTTC: acc.totalTTC + f.totaux.totalTTC,
      }),
      { totalHT: 0, totalTVA: 0, totalTTC: 0 },
    );

    const lignesExport = factures.map((f) => ({
      numero: f.numero,
      type: f.type,
      statut: f.statut,
      dateEmission: f.emiseLe,
      horodatageCertifie: f.horodatageCertifie ?? null,
      identifiantCertificationDGI: f.identifiantCertificationDGI ?? null,
      client: { nom: f.clientNom, ncc: f.clientNcc ?? null },
      lignes: f.lignes,
      totaux: f.totaux,
      versionReferentielFiscal: f.versionReferentielFiscal,
      empreinte: f.hash,
      empreintePrecedente: f.hashPrecedent,
      contenuQR: f.contenuQR ?? null,
    }));

    const empreinteExport = this.signer(canoniser(lignesExport));
    const id = randomUUID();
    const genereLe = new Date().toISOString();

    // L'export est tracé : un contrôle qui s'appuie dessus doit pouvoir être
    // rattaché à une demande identifiée.
    await this.bdd.avecTenant(entrepriseId, async (tx) => {
      await tx`
        INSERT INTO exports_controle (
          id, entreprise_id, demande_par, motif, periode_debut, periode_fin,
          nombre_factures, empreinte_export, chaine_valide, genere_le
        ) VALUES (
          ${id}, ${entrepriseId}, ${demande.parUtilisateur ?? null}, ${demande.motif ?? null},
          ${periode.debut}, ${periode.fin}, ${factures.length}, ${empreinteExport},
          ${verification.valide}, ${genereLe}
        )
      `;
    });

    return {
      id,
      genereLe,
      entreprise: {
        ncc: entreprise?.ncc ?? '',
        raisonSociale: entreprise?.raison_sociale ?? '',
        regimeFiscal: entreprise?.regime_fiscal ?? '',
      },
      periode: { debut: periode.debut, fin: periode.fin },
      nombreFactures: factures.length,
      chaineValide: verification.valide,
      anomalies: verification.anomalies,
      totaux,
      factures: lignesExport,
      empreinteExport,
      commentVerifier: INSTRUCTIONS_VERIFICATION,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Interne                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Charge les factures dans l'ordre d'émission.
   *
   * L'ordre compte : la chaîne d'intégrité ne se vérifie que dans l'ordre où
   * elle a été construite. Le numéro départage deux factures émises dans la même
   * milliseconde.
   */
  private async chargerFactures(
    entrepriseId: string,
    periode?: { debut?: string; fin?: string },
  ): Promise<Facture[]> {
    return this.bdd.avecTenant(entrepriseId, async (tx) => {
      const debut = periode?.debut ?? '1970-01-01';
      const fin = periode?.fin ?? '2999-12-31';

      const lignes = await tx<
        {
          id: string;
          entreprise_id: string;
          point_de_vente_id: string;
          terminal_id: string;
          type: string;
          statut: string;
          numero: string;
          emise_le: Date;
          horodatage_certifie: Date | null;
          client_id: string | null;
          client_nom: string;
          client_ncc: string | null;
          totaux: Facture['totaux'];
          lignes: Facture['lignes'];
          version_referentiel: string;
          hash_precedent: string;
          hash: string;
          identifiant_dgi: string | null;
          contenu_qr: string | null;
        }[]
      >`
        SELECT * FROM factures
         WHERE emise_le >= ${debut} AND emise_le <= ${fin}
         ORDER BY emise_le ASC, numero ASC
      `;

      return lignes.map((l) => ({
        id: l.id,
        entrepriseId: l.entreprise_id,
        pointDeVenteId: l.point_de_vente_id,
        terminalId: l.terminal_id,
        type: l.type as Facture['type'],
        statut: l.statut as Facture['statut'],
        numero: l.numero,
        emiseLe: l.emise_le.toISOString(),
        ...(l.horodatage_certifie
          ? { horodatageCertifie: l.horodatage_certifie.toISOString() }
          : {}),
        ...(l.client_id ? { clientId: l.client_id } : {}),
        clientNom: l.client_nom,
        ...(l.client_ncc ? { clientNcc: l.client_ncc } : {}),
        lignes: l.lignes,
        totaux: l.totaux,
        versionReferentielFiscal: l.version_referentiel,
        hashPrecedent: l.hash_precedent,
        hash: l.hash,
        ...(l.identifiant_dgi ? { identifiantCertificationDGI: l.identifiant_dgi } : {}),
        ...(l.contenu_qr ? { contenuQR: l.contenu_qr } : {}),
      }));
    });
  }

  /**
   * Signature du scellé.
   *
   * HMAC avec un secret serveur : cela prouve que le scellé vient bien de notre
   * service, mais PAS la date à laquelle il a été posé — nous pourrions le
   * produire a posteriori. C'est précisément ce qu'une autorité d'horodatage
   * tierce apporterait, et c'est pourquoi `horodatage_qualifie` reste faux.
   */
  private signer(contenu: string): string {
    return createHmac('sha256', this.config.JWT_SECRET).update(contenu).digest('hex');
  }
}
