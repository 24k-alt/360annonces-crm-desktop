# Publier l'app desktop (360annonces CRM)

Pipeline : `.github/workflows/desktop.yml` (non testé tant qu'il n'a pas tourné sur GitHub).

## Étapes
1. Vérifier que `version` est identique dans `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`.
2. Push sur GitHub, puis : `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`
   (ou GitHub > Actions > **desktop** > *Run workflow*).
3. 4 jobs : windows-x64, macos-arm64, macos-x64, linux-x64 (~15-30 min ; les minutes macOS comptent x10 sur un dépôt privé).
4. GitHub > Releases : un **brouillon** apparaît avec `.exe` (NSIS), 2 `.dmg`, `.deb`, `.AppImage`. Télécharger, tester, puis *Publish*.
   Pour changer l'icône : committer `desktop-app/app-icon.png` (carré, 1024 px) ; le workflow lance `cargo tauri icon`.

## Avertissements (builds non signés)
- **Windows SmartScreen** : "Windows a protégé votre PC" > *Informations complémentaires* > *Exécuter quand même*. Disparaît avec un certificat de signature de code (réputation progressive ; EV = immédiat).
- **macOS Gatekeeper** : "app endommagée / développeur non identifié". Clic droit > *Ouvrir*, ou `xattr -dr com.apple.quarantine "/Applications/360annonces CRM.app"`. Disparaît avec signature + notarisation (Apple Developer, 99 $/an).
- **Linux** : pas d'avertissement ; `chmod +x *.AppImage` puis lancer.

## Ajouter la signature plus tard (Settings > Secrets > Actions ; tous optionnels)
- macOS : `APPLE_CERTIFICATE` (.p12 en base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (mot de passe d'app), `APPLE_TEAM_ID`. Déjà reliés dans le workflow.
- Windows : pas encore relié. Il faudra un certificat (ou Azure Trusted Signing) + `bundle.windows.signCommand` dans `tauri.conf.json` + les secrets dans le workflow.
- Updater : `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`), générée par `cargo tauri signer generate -w ~/.tauri/crm.key`. Garder la clé privée hors du dépôt et sauvegardée : la perdre = plus aucune mise à jour possible.

## Auto-updater (description seulement, non implémenté)
1. Ajouter `tauri-plugin-updater` (Cargo, `.plugin(...)`, permission `updater:default`).
2. `tauri.conf.json` : `bundle.createUpdaterArtifacts: true`, `plugins.updater.pubkey` (clé publique) et `endpoints`, p. ex. `https://github.com/24k-alt/crm-eco-ecosystem/releases/latest/download/latest.json`.
3. Avec `TAURI_SIGNING_PRIVATE_KEY`, le workflow publie alors les `.sig` et `latest.json` dans la release (générés par `tauri-action`).
4. Côté app : vérifier au démarrage, télécharger, installer, relancer. Seules les releases *publiées* (pas brouillons) sont vues par `latest` ; si le dépôt a d'autres releases, prévoir un endpoint dédié aux tags `desktop-v*`.
