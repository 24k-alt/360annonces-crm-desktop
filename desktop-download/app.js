/* ---- À CONFIGURER ---------------------------------------------------- */
var REPO = "24k-alt/360annonces-crm-desktop"; // <owner>/<repo> des Releases GitHub
var BASE = "https://github.com/" + REPO + "/releases/latest/download/";
var MANIFEST_URL = "latest.json"; // même origine que la page (voir README.md)
// Noms stables : voir FILENAMES.md (la CI doit renommer les fichiers de tauri-action).
var FILES = {
  windows:  { key: "windows",  label: "Windows",               url: BASE + "360annonces-CRM-setup.exe" },
  macArm:   { key: "macArm",   label: "macOS (Apple Silicon)", url: BASE + "360annonces-CRM-mac-arm64.dmg" },
  macIntel: { key: "macIntel", label: "macOS (Intel)",         url: BASE + "360annonces-CRM-mac-x64.dmg" },
  linux:    { key: "linux",    label: "Linux (AppImage)",      url: BASE + "360annonces-CRM-linux-x64.AppImage" },
  deb:      { key: "deb",      label: "Linux (.deb)",          url: BASE + "360annonces-CRM-linux-x64.deb" }
};
/* ---------------------------------------------------------------------- */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var manifest = null, os = detect();

  function detect() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "", ua = navigator.userAgent;
    if (/android|iphone|ipad/i.test(ua)) return "windows"; // mobile : le CRM web reste l'option ; on affiche Windows par défaut
    if (/mac/i.test(p + ua)) return "mac";
    if (/linux|x11|cros/i.test(p + ua)) return "linux";
    return "windows";
  }
  function primary() { return os === "mac" ? FILES.macArm : os === "linux" ? FILES.linux : FILES.windows; }
  function others() { return os === "mac" ? [FILES.macIntel] : os === "linux" ? [FILES.deb] : []; }
  function info(f) { return (manifest && manifest.files && manifest.files[f.key]) || null; }
  function mb(n) { return n ? (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace(".", ",") + " Mo" : ""; }

  function render() {
    document.documentElement.dataset.os = os;
    document.querySelectorAll("[data-set]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.set === os)); });
    var f = primary(), i = info(f);
    var btn = $("dl-btn");
    btn.href = f.url;
    btn.textContent = "Télécharger pour " + (os === "mac" ? "macOS" : f.label.replace(/ \(.*/, ""));
    var parts = [];
    if (manifest && manifest.version) parts.push("Version " + manifest.version);
    if (i && i.size) parts.push(mb(i.size));
    if (manifest && manifest.date) { var d = new Date(manifest.date); if (!isNaN(d)) parts.push(d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })); }
    $("meta").textContent = parts.join(" · ");
    var alt = $("alt");
    alt.textContent = "";
    others().forEach(function (o) {
      var a = document.createElement("a");
      a.href = o.url; a.textContent = o.label;
      alt.append(o.key === "macIntel" ? "Mac Intel (avant 2020) ? " : "Autre format : ", a);
    });
    $("sha").textContent = (i && i.sha256) || "indisponible pour le moment";
  }

  document.querySelectorAll("[data-set]").forEach(function (b) { b.addEventListener("click", function () { os = b.dataset.set; render(); }); });
  $("copy").addEventListener("click", function () {
    var t = $("sha").textContent, b = this;
    if (!/^[0-9a-f]{64}$/i.test(t) || !navigator.clipboard) return;
    navigator.clipboard.writeText(t).then(function () { b.textContent = "Copié"; setTimeout(function () { b.textContent = "Copier"; }, 1500); });
  });

  render(); // fonctionne sans manifeste : liens + noms stables suffisent
  fetch(MANIFEST_URL, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (m) { manifest = m; render(); }).catch(function () { /* repli : pas de version/taille/empreinte */ });
})();
