# Noms de fichiers stables

La page `index.html` pointe vers `https://github.com/<owner>/<repo>/releases/latest/download/<nom>`. Ces noms ne doivent **jamais** changer :

| OS | Nom stable | Clé `latest.json` |
|---|---|---|
| Windows | `360annonces-CRM-setup.exe` | `windows` |
| macOS Apple Silicon | `360annonces-CRM-mac-arm64.dmg` | `macArm` |
| macOS Intel | `360annonces-CRM-mac-x64.dmg` | `macIntel` |
| Linux | `360annonces-CRM-linux-x64.AppImage` | `linux` |
| Linux (Debian/Ubuntu) | `360annonces-CRM-linux-x64.deb` | `deb` |

`tauri-action` publie des noms avec version et espaces, par exemple `360annonces CRM_0.1.0_x64-setup.exe`, `..._aarch64.dmg`, `..._x64.dmg`, `..._amd64.AppImage`, `..._amd64.deb` (à confirmer sur la première release : motifs ci-dessous à ajuster).

## Étape CI à ajouter (job final, après les 4 builds, `needs: build`)

```yaml
  stable-names:
    needs: build
    runs-on: ubuntu-latest
    permissions: { contents: write }
    env: { GH_TOKEN: "${{ github.token }}" }
    steps:
      - run: |
          TAG="${{ github.ref_name }}"; mkdir a && cd a
          gh release download "$TAG" -R "$GITHUB_REPOSITORY" --pattern '*setup.exe' --pattern '*.dmg' --pattern '*.AppImage' --pattern '*.deb'
          mv *x64-setup.exe 360annonces-CRM-setup.exe
          mv *aarch64.dmg   360annonces-CRM-mac-arm64.dmg
          mv *_x64.dmg      360annonces-CRM-mac-x64.dmg
          mv *.AppImage     360annonces-CRM-linux-x64.AppImage
          mv *.deb          360annonces-CRM-linux-x64.deb
          python3 - <<'PY' > latest.json
          import json,hashlib,os,datetime
          m={"windows":"360annonces-CRM-setup.exe","macArm":"360annonces-CRM-mac-arm64.dmg","macIntel":"360annonces-CRM-mac-x64.dmg","linux":"360annonces-CRM-linux-x64.AppImage","deb":"360annonces-CRM-linux-x64.deb"}
          f={k:{"name":v,"size":os.path.getsize(v),"sha256":hashlib.sha256(open(v,"rb").read()).hexdigest()} for k,v in m.items()}
          print(json.dumps({"version":os.environ["TAG"].removeprefix("desktop-v"),"date":datetime.datetime.utcnow().isoformat()+"Z","files":f}))
          PY
          gh release upload "$TAG" -R "$GITHUB_REPOSITORY" --clobber 360annonces-CRM-*
```

(`export TAG` avant le `python3`.) Ensuite, copier `latest.json` dans le dossier publié par Pages (commit sur la branche Pages, ou job `actions/deploy-pages`). Ne pas l'uploader sous le nom `latest.json` dans la release : ce nom est celui du manifeste de l'auto-updater Tauri.

Limite : `releases/latest/download` vise la dernière release **publiée** (ni brouillon, ni pré-release) du dépôt entier. Garder ce dépôt uniquement pour les releases desktop, ou utiliser une URL à tag fixe.
