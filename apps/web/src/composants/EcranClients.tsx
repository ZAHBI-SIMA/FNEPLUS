'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alerte, Bouton, Carte } from '@fneplus/ui';
import { terminal } from '@/lib/client-terminal';
import type { LigneClient } from '@/lib/depot/clients';

/**
 * Répertoire clients.
 *
 * Tout fonctionne hors ligne : la recherche interroge la base locale, et
 * l'enregistrement écrit en local puis empile une commande de synchronisation.
 * Aucun indicateur de chargement réseau, parce qu'il n'y a pas d'attente réseau.
 */
export function EcranClients({ surChangement }: { surChangement: () => void }) {
  const [clients, setClients] = useState<LigneClient[]>([]);
  const [recherche, setRecherche] = useState('');
  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [saisie, setSaisie] = useState({ nom: '', telephone: '', ncc: '' });
  const [erreur, setErreur] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const charger = useCallback(async (filtre: string) => {
    try {
      setClients(await terminal().listerClients(filtre));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void charger(recherche);
  }, [charger, recherche]);

  const enregistrer = (e: FormEvent) => {
    e.preventDefault();
    setOccupe(true);
    setErreur(null);

    void (async () => {
      try {
        const client = await terminal().enregistrerClient({
          nom: saisie.nom,
          ...(saisie.telephone ? { telephone: saisie.telephone } : {}),
          ...(saisie.ncc ? { ncc: saisie.ncc } : {}),
        });
        setConfirmation(`${client.nom} a été enregistré sur cet appareil.`);
        setSaisie({ nom: '', telephone: '', ncc: '' });
        setFormulaireOuvert(false);
        await charger(recherche);
        surChangement();
      } catch (e) {
        setErreur(e instanceof Error ? e.message : String(e));
      } finally {
        setOccupe(false);
      }
    })();
  };

  return (
    <>
      <header>
        <h1 className="fne-titre-page">Clients</h1>
        <p className="fne-sous-titre">
          Enregistrés sur cet appareil. Ils partiront au serveur au retour du réseau.
        </p>
      </header>

      {erreur ? <Alerte ton="erreur">{erreur}</Alerte> : null}
      {confirmation ? <Alerte ton="info">{confirmation}</Alerte> : null}

      {formulaireOuvert ? (
        <Carte titre="Nouveau client">
          <form className="fne-formulaire" onSubmit={enregistrer}>
            <label className="fne-champ">
              <span>Nom</span>
              <input
                required
                autoFocus
                value={saisie.nom}
                onChange={(e) => setSaisie({ ...saisie, nom: e.target.value })}
                placeholder="Nom du client ou de l’entreprise"
              />
            </label>
            <label className="fne-champ">
              <span>Téléphone</span>
              <input
                type="tel"
                inputMode="tel"
                value={saisie.telephone}
                onChange={(e) => setSaisie({ ...saisie, telephone: e.target.value })}
                placeholder="07 00 00 00 00"
              />
            </label>
            <label className="fne-champ">
              <span>NCC (facture entre entreprises)</span>
              <input
                value={saisie.ncc}
                onChange={(e) => setSaisie({ ...saisie, ncc: e.target.value })}
                placeholder="Facultatif"
              />
            </label>
            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur disabled={occupe}>
                {occupe ? 'Enregistrement…' : 'Enregistrer'}
              </Bouton>
              <Bouton variante="discret" onClick={() => setFormulaireOuvert(false)}>
                Annuler
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : (
        <div className="fne-actions">
          <Bouton pleineLargeur onClick={() => setFormulaireOuvert(true)}>
            Ajouter un client
          </Bouton>
        </div>
      )}

      <Carte titre={`Répertoire (${clients.length})`}>
        <label className="fne-champ">
          <span className="fne-visuellement-cache">Rechercher un client</span>
          <input
            type="search"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher par nom ou téléphone"
          />
        </label>

        {clients.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--fne-texte-faible)' }}>
            {recherche ? 'Aucun client ne correspond.' : 'Aucun client enregistré.'}
          </p>
        ) : (
          <div className="fne-pile">
            {clients.map((c) => (
              <div key={c.id} className="fne-facture">
                <span>{c.nom}</span>
                <span className="fne-facture__montant">{c.telephone ?? ''}</span>
                {c.ncc ? <span className="fne-facture__client">NCC {c.ncc}</span> : null}
              </div>
            ))}
          </div>
        )}
      </Carte>
    </>
  );
}
