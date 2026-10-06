# 360annonces CRM — application de bureau

Client de bureau (Tauri v2, Rust) pour un CRM Twenty. Il ouvre le CRM de votre agence dans une fenêtre sécurisée et sert de base à un futur poste de pilotage d'agents IA.

- **Télécharger** : voir la page de téléchargement (GitHub Pages de ce dépôt) ou l'onglet *Releases*.
- **Autre workspace** : au premier lancement ou via « Changer de CRM » sur l'écran de démarrage, entrez l'adresse https de votre CRM. Pour une version préconfigurée, définir la variable de dépôt `CRM_DEFAULT_URL` avant de lancer le workflow.
- **Sécurité** : la fenêtre ne peut afficher que le CRM configuré ; les autres liens s'ouvrent dans le navigateur ; le site du CRM n'a aucun accès aux fonctions internes de l'application.
- **Compiler** : voir `desktop-app/RELEASING.md`.

Prototype : non signé, non mesuré sous Windows (voir `desktop-app/README.md`).
