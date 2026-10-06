# Ce que voit l'utilisateur (installeur Windows)

Conçu pour un employé non technique : aucun mot de passe administrateur, installation dans son profil (`%LOCALAPPDATA%`), tout en français.

1. **Téléchargement** : clic sur « Télécharger pour Windows » sur la page.
2. **Avertissement SmartScreen** (installeur non signé) : « Windows a protégé votre PC » > *Informations complémentaires* > *Exécuter quand même*. Disparaît avec un certificat de signature.
3. **Bienvenue** : bandeau bleu 360annonces à gauche. Bouton *Suivant*.
4. **Dossier d'installation** : déjà rempli. Bouton *Installer* (c'est la seule vraie « question » : le modèle Tauri ne permet pas de la supprimer sans modèle NSIS personnalisé).
5. **Installation** : barre de progression ; si Windows n'a pas WebView2 (rare sur Windows 10/11 à jour), il est téléchargé automatiquement (connexion internet requise, quelques secondes).
6. **Terminé** : case « Lancer 360annonces CRM » cochée par défaut : *Terminer* ouvre l'application. Raccourcis dans le menu Démarrer (à la racine, voir ci-dessous) et sur le Bureau (créé par `hooks.nsh`).

Pourquoi pas de `startMenuFolder` : le renseigner ajoute une page « Dossier du menu Démarrer » (vérifié dans le modèle `installer.nsi` de Tauri). On l'omet pour réduire les clics ; le raccourci est créé à la racine du menu Démarrer.

Désinstallation : Paramètres > Applications. Mise à jour : relancer le nouvel installeur (propose de réinstaller par-dessus).

Installation silencieuse (parc géré par un administrateur) : `360annonces-CRM-setup.exe /S`.

WebView2 : `downloadBootstrapper` (+0 Mo dans l'installeur). `embedBootstrapper` ajoute ~1,8 Mo et `offlineInstaller` ~127 Mo ; inutiles car l'application elle-même a besoin d'internet (CRM en ligne), donc un PC hors ligne ne pourrait de toute façon pas s'en servir.
