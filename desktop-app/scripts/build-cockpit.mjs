// Build-time only (Node is NOT shipped). Builds ui-harness with Vite and copies dist/ to ui/cockpit/.
// Calls the tools by file path: the repo path contains '&', which breaks `npm run` under cmd.exe.
// Usage: node scripts/build-cockpit.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const harness = join(app, 'ui-harness')
const out = join(app, 'ui', 'cockpit')

function run(label, script, args) {
  const r = spawnSync(process.execPath, [join(harness, 'node_modules', script), ...args], { cwd: harness, stdio: 'inherit' })
  if (r.status !== 0) { console.error(`cockpit build failed at: ${label}`); process.exit(r.status ?? 1) }
}
if (!existsSync(join(harness, 'node_modules'))) { console.error('ui-harness/node_modules missing: run `npm install` in ui-harness first.'); process.exit(1) }

run('typecheck', 'typescript/bin/tsc', ['--noEmit'])
run('vite build', 'vite/bin/vite.js', ['build'])
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(harness, 'dist'), out, { recursive: true })
console.log(`cockpit copied to ${out} (open as cockpit/index.html)`)
