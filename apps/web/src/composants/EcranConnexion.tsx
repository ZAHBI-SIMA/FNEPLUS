'use client';

import { useState, type FormEvent } from 'react';
import { Alerte, Bouton, Carte } from '@fneplus/ui';
import type { RegimeFiscal } from '@fneplus/core';
import { terminal } from '@/lib/client-terminal';
import type { EtatTerminal } from '@/lib/protocole-terminal';

/**
 * Parcours d'entrée dans l'application.
 *
 * Une seule question par écran, et jamais plus de champs que nécessaire :
 * l'inscription se fait souvent debout dans une boutique, sur un téléphone
 * d'entrée de gamme. Chaque champ supplémentaire coûte des abandons.
 */
type Etape = 'ACCUEIL' | 'INSCRIPTION' | 'TELEPHONE' | 'CODE' | 'PIN' | 'DEFINIR_PIN';

const REGIMES: { valeur: RegimeFiscal; libelle: string; aide: string }[] = [
  { valeur: 'ENTREPRENANT', libelle: 'Entreprenant', aide: 'Chiffre d’affaires jusqu’à 50 M FCFA' },
  {
    valeur: 'MICROENTREPRISE',
    libelle: 'Microentreprise',
    aide: 'De 50 à 200 M FCFA',
  },
  {
    valeur: 'REEL_SIMPLIFIE',
    libelle: 'Réel simplifié',
    aide: 'De 200 à 500 M FCFA — assujetti à la TVA',
  },
  {
    valeur: 'REEL_NORMAL',
    libelle: 'Réel normal',
    aide: 'Au-delà de 500 M FCFA — assujetti à la TVA',
  },
];

export function EcranConnexion({
  surConnexion,
  avertissementStockage,
}: {
  surConnexion: (etat: EtatTerminal) => void;
  /**
   * Avertissement sur la persistance locale.
   *
   * Affiché AVANT la connexion, et pas seulement après : c'est justement au
   * moment de s'installer sur un appareil qu'il faut savoir que celui-ci ne
   * garderait pas les factures.
   */
  avertissementStockage?: string | undefined;
}) {
  const [etape, setEtape] = useState<Etape>('ACCUEIL');
  const [telephone, setTelephone] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const [inscription, setInscription] = useState({
    raisonSociale: '',
    ncc: '',
    regimeFiscal: 'REEL_SIMPLIFIE' as RegimeFiscal,
    nomProprietaire: '',
    adresse: '',
  });

  async function executer(travail: () => Promise<void>) {
    setOccupe(true);
    setErreur(null);
    try {
      await travail();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }

  const soumettreInscription = (e: FormEvent) => {
    e.preventDefault();
    void executer(async () => {
      await terminal().inscrire({ ...inscription, telephone });
      await terminal().demanderCode(telephone);
      setInfo('Compte créé. Un code de connexion vient d’être envoyé par SMS.');
      setEtape('CODE');
    });
  };

  const demanderCode = (e: FormEvent) => {
    e.preventDefault();
    void executer(async () => {
      await terminal().demanderCode(telephone);
      setInfo('Si ce numéro correspond à un compte, un code vient d’être envoyé par SMS.');
      setEtape('CODE');
    });
  };

  const verifierCode = (e: FormEvent) => {
    e.preventDefault();
    void executer(async () => {
      const resultat = await terminal().verifierCode({ telephone, code });
      if (resultat.definirPin) {
        setInfo('Choisissez un code à 4 chiffres pour vos prochaines connexions.');
        setEtape('DEFINIR_PIN');
        surConnexion(resultat.etat);
      } else {
        surConnexion(resultat.etat);
      }
    });
  };

  const connexionPin = (e: FormEvent) => {
    e.preventDefault();
    void executer(async () => {
      const resultat = await terminal().connexionPin({ telephone, code: pin });
      surConnexion(resultat.etat);
    });
  };

  const definirPin = (e: FormEvent) => {
    e.preventDefault();
    void executer(async () => {
      await terminal().definirPin(pin);
      surConnexion(await terminal().etat());
    });
  };

  return (
    <main className="fne-conteneur fne-contenu">
      <header>
        <h1 className="fne-titre-page">
          {etape === 'INSCRIPTION' ? 'Créer votre compte' : 'Bienvenue sur FNE+'}
        </h1>
        <p className="fne-sous-titre">Facturation conforme FNE, même sans réseau.</p>
      </header>

      {avertissementStockage ? <Alerte ton="attente">{avertissementStockage}</Alerte> : null}
      {info ? <Alerte ton="info">{info}</Alerte> : null}
      {erreur ? <Alerte ton="erreur">{erreur}</Alerte> : null}

      {etape === 'ACCUEIL' ? (
        <Carte>
          <div className="fne-pile">
            <Bouton pleineLargeur onClick={() => setEtape('TELEPHONE')}>
              J’ai déjà un compte
            </Bouton>
            <Bouton variante="secondaire" pleineLargeur onClick={() => setEtape('INSCRIPTION')}>
              Inscrire mon entreprise
            </Bouton>
          </div>
        </Carte>
      ) : null}

      {etape === 'INSCRIPTION' ? (
        <Carte titre="Votre entreprise">
          <form className="fne-formulaire" onSubmit={soumettreInscription}>
            <label className="fne-champ">
              <span>Nom de l’entreprise</span>
              <input
                required
                value={inscription.raisonSociale}
                onChange={(e) => setInscription({ ...inscription, raisonSociale: e.target.value })}
                autoComplete="organization"
                placeholder="Boutique Aïcha"
              />
            </label>

            <label className="fne-champ">
              <span>Numéro de compte contribuable (NCC)</span>
              <input
                required
                value={inscription.ncc}
                onChange={(e) => setInscription({ ...inscription, ncc: e.target.value })}
                placeholder="CI-1234567-A"
              />
            </label>

            <fieldset className="fne-champ">
              <legend>Régime fiscal</legend>
              <div className="fne-options">
                {REGIMES.map((r) => (
                  <label key={r.valeur} className="fne-option">
                    <input
                      type="radio"
                      name="regime"
                      value={r.valeur}
                      checked={inscription.regimeFiscal === r.valeur}
                      onChange={() => setInscription({ ...inscription, regimeFiscal: r.valeur })}
                    />
                    <span>
                      <strong>{r.libelle}</strong>
                      <span className="fne-option__aide">{r.aide}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="fne-champ">
              <span>Votre nom</span>
              <input
                required
                value={inscription.nomProprietaire}
                onChange={(e) =>
                  setInscription({ ...inscription, nomProprietaire: e.target.value })
                }
                autoComplete="name"
              />
            </label>

            <label className="fne-champ">
              <span>Téléphone</span>
              <input
                required
                type="tel"
                inputMode="tel"
                value={telephone}
                onChange={(e) => setTelephone(e.target.value)}
                autoComplete="tel"
                placeholder="07 00 00 00 00"
              />
            </label>

            <label className="fne-champ">
              <span>Adresse de la boutique</span>
              <input
                value={inscription.adresse}
                onChange={(e) => setInscription({ ...inscription, adresse: e.target.value })}
                placeholder="Treichville, Abidjan"
              />
            </label>

            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur disabled={occupe}>
                {occupe ? 'Création…' : 'Créer mon compte'}
              </Bouton>
              <Bouton variante="discret" onClick={() => setEtape('ACCUEIL')}>
                Retour
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : null}

      {etape === 'TELEPHONE' ? (
        <Carte titre="Votre numéro">
          <form className="fne-formulaire" onSubmit={demanderCode}>
            <label className="fne-champ">
              <span>Téléphone</span>
              <input
                required
                type="tel"
                inputMode="tel"
                value={telephone}
                onChange={(e) => setTelephone(e.target.value)}
                autoComplete="tel"
                placeholder="07 00 00 00 00"
              />
            </label>
            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur disabled={occupe}>
                {occupe ? 'Envoi…' : 'Recevoir un code par SMS'}
              </Bouton>
              <Bouton variante="secondaire" pleineLargeur onClick={() => setEtape('PIN')}>
                J’ai déjà un code à 4 chiffres
              </Bouton>
              <Bouton variante="discret" onClick={() => setEtape('ACCUEIL')}>
                Retour
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : null}

      {etape === 'CODE' ? (
        <Carte titre="Code reçu par SMS">
          <form className="fne-formulaire" onSubmit={verifierCode}>
            <label className="fne-champ">
              <span>Code à 6 chiffres</span>
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                autoComplete="one-time-code"
                className="fne-champ--code"
              />
            </label>
            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur disabled={occupe || code.length !== 6}>
                {occupe ? 'Vérification…' : 'Me connecter'}
              </Bouton>
              <Bouton
                variante="discret"
                onClick={() => void executer(() => terminal().demanderCode(telephone).then())}
              >
                Renvoyer le code
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : null}

      {etape === 'PIN' ? (
        <Carte titre="Connexion rapide">
          <form className="fne-formulaire" onSubmit={connexionPin}>
            <label className="fne-champ">
              <span>Téléphone</span>
              <input
                required
                type="tel"
                inputMode="tel"
                value={telephone}
                onChange={(e) => setTelephone(e.target.value)}
                autoComplete="tel"
              />
            </label>
            <label className="fne-champ">
              <span>Votre code</span>
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{4,6}"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                autoComplete="current-password"
                className="fne-champ--code"
              />
            </label>
            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur disabled={occupe}>
                {occupe ? 'Connexion…' : 'Me connecter'}
              </Bouton>
              <Bouton variante="discret" onClick={() => setEtape('TELEPHONE')}>
                J’ai oublié mon code
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : null}

      {etape === 'DEFINIR_PIN' ? (
        <Carte titre="Choisir un code">
          <p style={{ marginTop: 0, fontSize: '0.875rem' }}>
            Ce code vous évitera d’attendre un SMS à chaque connexion. Ne le communiquez à personne.
          </p>
          <form className="fne-formulaire" onSubmit={definirPin}>
            <label className="fne-champ">
              <span>Code à 4 chiffres</span>
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{4,6}"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                autoComplete="new-password"
                className="fne-champ--code"
              />
            </label>
            <div className="fne-actions">
              <Bouton type="submit" pleineLargeur disabled={occupe || pin.length < 4}>
                {occupe ? 'Enregistrement…' : 'Enregistrer mon code'}
              </Bouton>
            </div>
          </form>
        </Carte>
      ) : null}
    </main>
  );
}
