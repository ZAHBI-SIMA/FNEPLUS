'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alerte, Badge, Bouton, Carte } from '@fneplus/ui';
import { terminal } from '@/lib/client-terminal';
import type { Anomalie, EtatTerminal } from '@/lib/protocole-terminal';

/**
 * Écran « à vérifier ».
 *
 * Il rassemble ce que le terminal ne sait pas réparer seul. Chaque entrée dit
 * trois choses : ce qui s'est passé, ce que ça implique, et quoi faire. Une
 * anomalie qu'on affiche sans action possible n'aide personne.
 *
 * L'écran vide est un bon écran : c'est l'état normal, et il le dit.
 */
export function EcranAVerifier({ surChangement }: { surChangement: (etat: EtatTerminal) => void }) {
  const [anomalies, setAnomalies] = useState<Anomalie[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const charger = useCallback(async () => {
    try {
      setAnomalies(await terminal().listerAnomalies());
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  const reessayer = useCallback(
    async (anomalie: Anomalie) => {
      setOccupe(true);
      setMessage(null);
      try {
        surChangement(await terminal().reessayer(anomalie.id));
        setMessage('Remis en file. L’envoi repartira à la prochaine connexion.');
        await charger();
      } catch (e) {
        setErreur(e instanceof Error ? e.message : String(e));
      } finally {
        setOccupe(false);
      }
    },
    [charger, surChangement],
  );

  const purger = useCallback(async () => {
    setOccupe(true);
    try {
      const r = await terminal().purgerStockage();
      setMessage(
        r.commandesPurgees + r.entreesJournalPurgees === 0
          ? 'Rien à libérer : le stockage est déjà au propre.'
          : `${r.commandesPurgees} envois confirmés et ${r.entreesJournalPurgees} lignes de journal libérés. Aucune facture n’a été touchée.`,
      );
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }, []);

  return (
    <>
      <header>
        <h1 className="fne-titre-page">À vérifier</h1>
        <p className="fne-sous-titre">
          Ce que le terminal ne peut pas régler tout seul. Le reste part automatiquement.
        </p>
      </header>

      {erreur ? <Alerte ton="erreur">{erreur}</Alerte> : null}
      {message ? <Alerte ton="info">{message}</Alerte> : null}

      {anomalies === null ? (
        <p>Vérification…</p>
      ) : anomalies.length === 0 ? (
        <Carte>
          <p style={{ margin: 0 }}>
            <strong>Rien à signaler.</strong> Toutes vos factures sont enregistrées ou en route vers
            la DGI.
          </p>
        </Carte>
      ) : (
        <div className="fne-pile">
          {anomalies.map((a) => (
            <Carte key={a.id}>
              <div className="fne-anomalie__entete">
                <Badge ton={a.gravite === 'BLOQUANT' ? 'erreur' : 'attente'}>
                  {a.gravite === 'BLOQUANT' ? 'Bloquant' : 'À corriger'}
                </Badge>
                {a.survenuLe ? (
                  <span className="fne-anomalie__date fne-chiffres">
                    {new Intl.DateTimeFormat('fr-CI', { dateStyle: 'short' }).format(
                      new Date(a.survenuLe),
                    )}
                  </span>
                ) : null}
              </div>

              <h2 className="fne-anomalie__titre">{a.titre}</h2>
              <p className="fne-anomalie__detail">{a.detail}</p>
              <p className="fne-anomalie__action">{a.action}</p>

              {a.reessayable && a.id.startsWith('commande-') ? (
                <div className="fne-actions">
                  <Bouton variante="secondaire" onClick={() => void reessayer(a)} disabled={occupe}>
                    Réessayer l’envoi
                  </Bouton>
                </div>
              ) : null}
            </Carte>
          ))}
        </div>
      )}

      <Carte titre="Stockage de l’appareil">
        <p style={{ marginTop: 0, fontSize: '0.875rem' }}>
          Libère les envois déjà confirmés et les anciennes lignes de journal.{' '}
          <strong>Vos factures ne sont jamais effacées</strong> : elles doivent être conservées pour
          la durée légale.
        </p>
        <div className="fne-actions">
          <Bouton variante="secondaire" onClick={() => void purger()} disabled={occupe}>
            Libérer de l’espace
          </Bouton>
        </div>
      </Carte>
    </>
  );
}
