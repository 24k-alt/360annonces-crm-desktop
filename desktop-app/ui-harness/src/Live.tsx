// The REAL part of slice 1: IPC state, run card (live feed, answer, trace), first-run cards, settings.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import { ipc, type AgentEvent, type AgentSettings, type AgentState, type CrmSession } from './ipc'

type Theme = 'light' | 'dark'
type Meta = { task: string; at: number; cancelling?: boolean }
type Store = { ev: Record<string, AgentEvent[]>; meta: Record<string, Meta>; order: string[] }
type Act = { t: 'ev'; e: AgentEvent } | { t: 'meta'; id: string; task: string } | { t: 'cancelling'; id: string }

function reduce(s: Store, a: Act): Store {
  if (a.t === 'ev') {
    const cur = s.ev[a.e.run_id] ?? []
    if (cur.some(x => x.seq === a.e.seq)) return s
    return { ...s, ev: { ...s.ev, [a.e.run_id]: [...cur, a.e].sort((x, y) => x.seq - y.seq) } }
  }
  if (a.t === 'meta') return { ...s, meta: { ...s.meta, [a.id]: { task: a.task, at: Date.now() } }, order: [a.id, ...s.order.filter(x => x !== a.id)] }
  return { ...s, meta: { ...s.meta, [a.id]: { ...s.meta[a.id], cancelling: true } } }
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled'
export const statusOf = (ev: AgentEvent[]): RunStatus =>
  ev.some(x => x.kind === 'cancelled') ? 'cancelled' : ev.some(x => x.kind === 'error') ? 'error' : ev.some(x => x.kind === 'done' || x.kind === 'answer') ? 'done' : 'running'

export type Run = { id: string; task: string; at: number; events: AgentEvent[]; status: RunStatus; cancelling: boolean }

export function useAgent() {
  const [session, setSession] = useState<CrmSession | null>(null)
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  const [store, dispatch] = useReducer(reduce, { ev: {}, meta: {}, order: [] })

  const refresh = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([ipc.session(), ipc.settingsGet()])
      setSession(s); setSettings(g); setLoadErr(false)
    } catch (err) { console.error(err); setLoadErr(true) }
  }, [])
  useEffect(() => {
    refresh()
    addEventListener('focus', refresh) // user may have just signed in from the main window
    return () => removeEventListener('focus', refresh)
  }, [refresh])
  useEffect(() => ipc.onEvent(e => dispatch({ t: 'ev', e })), [])

  const runs: Run[] = store.order.map(id => {
    const events = store.ev[id] ?? []
    return { id, task: store.meta[id].task, at: store.meta[id].at, events, status: statusOf(events), cancelling: !!store.meta[id].cancelling }
  })
  const ready = !!session?.signed_in && !!settings?.openrouter_key_set
  const running = runs.some(r => r.status === 'running')

  /** Returns an employee-safe error message, or null on success. */
  const run = async (task: string): Promise<string | null> => {
    try { const id = await ipc.run(task); dispatch({ t: 'meta', id, task }); return null }
    catch (err) { console.error('agent_run failed', err); return "Impossible de lancer la demande. Vérifiez votre connexion, puis réessayez." }
  }
  const cancel = async (id: string) => { dispatch({ t: 'cancelling', id }); try { await ipc.cancel(id) } catch (err) { console.error(err) } }
  return { session, settings, loadErr, refresh, runs, ready, running, run, cancel }
}
export type Agent = ReturnType<typeof useAgent>

export function useOnline() {
  const [on, setOn] = useState(navigator.onLine)
  useEffect(() => {
    const f = () => setOn(navigator.onLine)
    addEventListener('online', f); addEventListener('offline', f)
    return () => { removeEventListener('online', f); removeEventListener('offline', f) }
  }, [])
  return on
}

/* ---------- small pieces ---------- */
const ORB: Record<Exclude<AgentState, null>, OrbState> = { thinking: 'solving', searching: 'searching', reading: 'working', writing: 'composing' }
export const Preview = () => <span className="tag" title="Exemple fictif : rien ici n'est réel pour l'instant">Aperçu</span>
const Check = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
const Cross = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
export const Lock = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>

export const ReadOnly = ({ compact }: { compact?: boolean }) => (
  <span className={`chip ro${compact ? ' sm' : ''}`}><Lock />Lecture seule : l'assistant ne peut rien envoyer ni modifier</span>
)

const toMs = (ts: number | string) => (typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts))
const clock = (ts: number | string) => { const d = new Date(toMs(ts)); return isNaN(+d) ? '' : d.toLocaleTimeString('fr-FR') }

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* fall through */ }
  const t = document.createElement('textarea')
  t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'
  document.body.appendChild(t); t.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  t.remove()
  return ok
}

/* ---------- run card ---------- */
const KIND_FR: Record<AgentEvent['kind'], string> = { step: 'Étape', tool_call: "Appel d'outil", tool_result: 'Résultat', answer: 'Réponse', error: 'Erreur', done: 'Fin', cancelled: 'Annulé' }
const STATUS: Record<RunStatus, [string, string]> = { running: ['blue', 'En cours'], done: ['ok', 'Terminé'], error: ['bad', 'Échec'], cancelled: ['', 'Arrêté'] }

export function RunCard({ run, admin, theme, reduced, cancel, retry }: { run: Run; admin: boolean; theme: Theme; reduced: boolean; cancel: () => void; retry: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const [details, setDetails] = useState(false)
  const [trace, setTrace] = useState<AgentEvent[] | null>(null)
  const [traceErr, setTraceErr] = useState(false)
  const n = run.events.length
  useEffect(() => {
    if (!admin || !details) return
    let live = true
    ipc.trace(run.id).then(t => { if (live) { setTrace(t); setTraceErr(false) } }).catch(() => live && setTraceErr(true))
    return () => { live = false }
  }, [admin, details, run.id, n])

  const feed = run.events.filter(x => x.kind === 'step' || x.kind === 'tool_call' || x.kind === 'tool_result')
  const answer = [...run.events].reverse().find(x => x.kind === 'answer')
  const err = run.events.find(x => x.kind === 'error')
  const cancelled = run.events.find(x => x.kind === 'cancelled')
  const [tone, label] = STATUS[run.status]
  const t0 = run.events[0] && toMs(run.events[0].ts)
  const t1 = run.events.length ? toMs(run.events[run.events.length - 1].ts) : 0
  return (
    <article className={`card run ${run.status}`} aria-label={`Demande : ${run.task}`}>
      <header>
        <h3>{run.task}</h3>
        <span className={`chip ${tone}`}>{label}</span>
        {run.status === 'running' && <button className="btn sm" onClick={cancel} disabled={run.cancelling}>{run.cancelling ? 'Arrêt…' : 'Arrêter'}</button>}
      </header>

      {(feed.length > 0 || run.status === 'running') && (
        <ol className="feed" aria-label="Ce que fait l'assistant">
          {feed.length === 0 && <li className="now"><span className="ic"><ThinkingOrb state="solving" size={20} theme={theme} paused={reduced} aria-hidden="true" /></span><span role="status">Je démarre…</span></li>}
          {feed.map((s, i) => {
            const last = i === feed.length - 1
            const live = last && run.status === 'running'
            return (
              <li key={s.seq} className={live ? 'now' : 'past'}>
                <span className="ic">
                  {live ? <ThinkingOrb state={ORB[s.state ?? 'thinking']} size={20} theme={theme} paused={reduced} aria-hidden="true" />
                    : last && run.status === 'error' ? <Cross /> : <Check />}
                </span>
                <span role={live ? 'status' : undefined}>{s.text}</span>
              </li>
            )
          })}
        </ol>
      )}

      {answer && (
        <section className="answer" aria-label="Réponse de l'assistant">
          <div className="ahead">
            <b>Réponse</b>
            <button className="btn sm" onClick={async () => { setCopied((await copy(answer.text)) ? 'ok' : 'fail'); setTimeout(() => setCopied(null), 2500) }}>{copied === 'ok' ? 'Copié' : 'Copier'}</button>
            <span className={copied === 'fail' ? 'small muted' : 'sr-only'} role="status">{copied === 'fail' ? 'Copie impossible : sélectionnez le texte puis Ctrl+C.' : copied === 'ok' ? 'Réponse copiée' : ''}</span>
          </div>
          <div className="atext">{answer.text}</div>
          <p className="small muted">Rien n'a été envoyé ni modifié dans le CRM.</p>
        </section>
      )}
      {err && (
        <div className="banner bad" role="alert">
          <div style={{ flex: 1 }}>
            <b>Ça n'a pas marché.</b> {err.text}
          </div>
          <button className="btn sm" onClick={retry}>Réessayer</button>
        </div>
      )}
      {cancelled && <p className="small muted" role="status">{cancelled.text || "Arrêté. Rien n'a été modifié."}</p>}

      {admin && (
        <div className="trace-wrap">
          <button className="btn sm" aria-pressed={details} onClick={() => setDetails(d => !d)}>{details ? 'Masquer les détails' : 'Détails'}</button>
          {details && (
            <div className="panel" style={{ marginTop: 8 }}>
              <div className="banner warn" role="note" style={{ borderRadius: 0, border: 0, borderBottom: '1px solid var(--warn-line)' }}>
                <div>Réservé aux administrateurs. Les valeurs sensibles sont censées être masquées par le serveur.{t0 && t1 ? ` Durée : ${((t1 - t0) / 1000).toFixed(1)} s.` : ''}</div>
              </div>
              {traceErr ? <p className="small" style={{ padding: 12, color: 'var(--bad)' }}>Trace indisponible.</p> : (
                <table className="trace" aria-label="Trace de l'exécution">
                  <thead><tr><th>#</th><th>Heure</th><th>Type</th><th>État</th><th>Texte</th><th>Détail</th></tr></thead>
                  <tbody>
                    {(trace ?? []).map(t => (
                      <tr key={t.seq}>
                        <td className="mono">{t.seq}</td><td className="mono">{clock(t.ts)}</td><td>{KIND_FR[t.kind]}</td>
                        <td className="mono">{t.state ?? ''}</td><td>{t.text}</td>
                        <td>{t.detail !== undefined && <code className="detail">{JSON.stringify(t.detail, null, 1)}</code>}</td>
                      </tr>
                    ))}
                    {trace && trace.length === 0 && <tr><td colSpan={6} className="muted">Aucun événement.</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

/* ---------- first-run cards ---------- */
export function SignedOutCard({ recheck, workspaceHint }: { recheck: () => Promise<void>; workspaceHint?: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="card setup" role="region" aria-label="Connexion au CRM requise">
      <h3>Connectez-vous d'abord au CRM</h3>
      <p className="muted">L'assistant lit vos données dans le CRM avec votre compte. Vous n'êtes pas connecté pour le moment{workspaceHint ? ` (${workspaceHint})` : ''}.</p>
      <ol className="how">
        <li>Ouvrez la fenêtre principale de l'application (« 360annonces CRM »).</li>
        <li>Connectez-vous avec votre compte habituel.</li>
        <li>Revenez ici, puis cliquez sur « Vérifier à nouveau ».</li>
      </ol>
      <div className="acts"><button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await recheck(); setBusy(false) }}>{busy ? 'Vérification…' : 'Vérifier à nouveau'}</button></div>
    </div>
  )
}

export function LoadErrorCard({ retry }: { retry: () => void }) {
  return (
    <div className="card setup" role="alert">
      <h3>L'assistant ne répond pas</h3>
      <p className="muted">L'application n'a pas pu lire son état. Vos données ne sont pas touchées. Fermez puis rouvrez cette fenêtre, ou réessayez.</p>
      <div className="acts"><button className="btn primary" onClick={retry}>Réessayer</button></div>
    </div>
  )
}

/** Key is masked, never echoed, never kept in state after saving. Model list limited to model_options. */
export function SettingsPanel({ settings, onSaved, first }: { settings: AgentSettings; onSaved: () => Promise<void>; first?: boolean }) {
  const keyRef = useRef<HTMLInputElement>(null)
  const [hasText, setHasText] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (patch: { openrouter_key?: string; model?: string }, okText: string) => {
    setBusy(true); setMsg(null)
    try {
      await ipc.settingsSet(patch)
      if (keyRef.current) keyRef.current.value = ''
      setHasText(false)
      await onSaved()
      setMsg({ ok: true, text: okText })
    } catch (err) { console.error(err); setMsg({ ok: false, text: "Enregistrement impossible. Réessayez." }) }
    setBusy(false)
  }
  return (
    <div className="setup-form">
      <form onSubmit={ev => { ev.preventDefault(); const v = keyRef.current?.value.trim(); if (v) save({ openrouter_key: v }, 'Clé enregistrée') }}>
        <label htmlFor="orkey"><b>Clé OpenRouter</b> {settings.openrouter_key_set && <span className="chip ok">Clé enregistrée</span>}</label>
        <div className="row">
          <input id="orkey" ref={keyRef} type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
            onChange={ev => setHasText(!!ev.target.value.trim())}
            placeholder={settings.openrouter_key_set ? 'Collez une nouvelle clé pour la remplacer' : 'Collez votre clé ici (sk-or-…)'} />
          <button className="btn primary" type="submit" disabled={busy || !hasText}>Enregistrer</button>
        </div>
        <p className="small muted">{first ? "La clé est le « mot de passe » du service qui écrit les réponses. " : ''}Elle reste sur cet ordinateur et n'est plus jamais affichée après l'enregistrement.</p>
      </form>
      <div>
        <label htmlFor="ormodel"><b>Modèle</b></label>
        <div className="row">
          <select id="ormodel" value={settings.model} disabled={busy || settings.model_options.length === 0} onChange={ev => save({ model: ev.target.value }, 'Modèle changé')}>
            {!settings.model_options.includes(settings.model) && <option value={settings.model} disabled>{settings.model}</option>}
            {settings.model_options.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <p className="small muted">Modèles gratuits uniquement : aucun coût, mais ils peuvent être plus lents ou moins précis.</p>
      </div>
      <p className="small" role="status" style={{ color: msg && !msg.ok ? 'var(--bad)' : 'var(--ok)', marginTop: -6 }}>{msg?.text}</p>
    </div>
  )
}

export function KeyCard({ settings, onSaved }: { settings: AgentSettings; onSaved: () => Promise<void> }) {
  return (
    <div className="card setup" role="region" aria-label="Configuration de l'assistant">
      <h3>Une dernière étape : ajouter la clé de l'assistant</h3>
      <p className="muted">L'assistant a besoin d'une clé OpenRouter (gratuite) pour écrire ses réponses. Collez-la une seule fois ci-dessous.</p>
      <SettingsPanel settings={settings} onSaved={onSaved} first />
    </div>
  )
}
