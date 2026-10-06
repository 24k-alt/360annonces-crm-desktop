# Page de téléchargement 360annonces CRM

Statique (HTML + `app.js`, aucun build). À héberger **hors** du serveur du CRM. Configuration : constantes en haut de `app.js` (`REPO`, `BASE`, `MANIFEST_URL`). Noms de fichiers et étape CI : `FILENAMES.md`. `latest.json` fourni = modèle vide (la page affiche « indisponible » tant que la CI ne l'a pas remplacé).

## Héberger gratuitement (comparatif)
| | GitHub Releases + Pages | Cloudflare Pages + R2 |
|---|---|---|
| Coût | 0 (dépôt public) | Pages 0 ; R2 : 10 Go gratuits, sorties de données gratuites |
| Limites | fichiers 2 Go ; Pages 100 Go/mois (usage souple) | Pages 25 Mo/fichier, donc l'installeur va dans R2 |
| Dépôt privé | Releases non téléchargeables sans connexion, Pages privé = offre payante : **le dépôt (ou un dépôt dédié) doit être public** | marche avec dépôt privé (déploiement via wrangler/Actions) |
| Mise en place | la plus simple, `releases/latest/download` intégré | R2 demande une carte bancaire, un bucket public, un domaine ou `r2.dev` |
| Choix | par défaut | si le code doit rester privé |

Mise en place GitHub Pages : Settings > Pages > déployer la racine de `desktop-download/` (ou copier le dossier sur une branche `gh-pages`). Le dépôt ne contient pas de secrets dans ce dossier.

## Brancher le popup du CRM
`web-popup/crm-app-popup.js` : `var DOWNLOAD_URL = "";` (vide = désactivé ; doit commencer par `https://`). Mettre l'URL de cette page, par exemple `https://24k-alt.github.io/crm-eco-ecosystem/`, puis redéployer le JS comme décrit dans `web-popup/README.md`. Le lien du popup s'ouvre dans un nouvel onglet : la page choisit le bon système toute seule. (Fichier non modifié ici.)
