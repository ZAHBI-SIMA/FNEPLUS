'use client';

import { useEffect, useState } from 'react';

/**
 * Rendu du QR code d'une facture.
 *
 * L'encodeur est chargé en import dynamique : il ne pèse sur le premier
 * chargement de personne, seulement sur l'écran qui affiche réellement un QR.
 *
 * Le rendu est un SVG, pas un canvas : il reste net à l'impression quelle que
 * soit la résolution, ce qui compte pour un ticket sorti d'une imprimante
 * thermique et scanné ensuite par un téléphone.
 */
export function CodeQR({
  contenu,
  taille = 160,
  provisoire = false,
}: {
  contenu: string;
  taille?: number;
  provisoire?: boolean;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;

    void (async () => {
      try {
        const { default: creerQR } = await import('qrcode-generator');
        // Type 0 = ajustement automatique de la taille de matrice au contenu.
        // Correction 'M' : environ 15 % de tolérance, le bon compromis entre
        // densité et résistance aux taches d'encre et aux plis d'un ticket.
        const qr = creerQR(0, 'M');
        qr.addData(contenu);
        qr.make();
        if (!annule) setSvg(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
      } catch (e) {
        if (!annule) setErreur(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      annule = true;
    };
  }, [contenu]);

  if (erreur) {
    return (
      <div className="fne-qr fne-qr--erreur" role="alert">
        QR indisponible : {erreur}
      </div>
    );
  }

  if (!svg) {
    return <div className="fne-qr fne-qr--attente" style={{ width: taille, height: taille }} />;
  }

  return (
    <figure className="fne-qr">
      <div
        className="fne-qr__image"
        style={{ width: taille, height: taille }}
        // Le SVG est produit localement par l'encodeur à partir d'une chaîne que
        // nous avons nous-mêmes construite : aucune donnée externe n'entre ici.
        dangerouslySetInnerHTML={{ __html: svg }}
        role="img"
        aria-label={`Code QR de la facture${provisoire ? ', en attente de certification' : ''}`}
      />
      <figcaption className="fne-qr__legende">
        {provisoire ? 'En attente de certification DGI' : 'Facture certifiée'}
      </figcaption>
    </figure>
  );
}
