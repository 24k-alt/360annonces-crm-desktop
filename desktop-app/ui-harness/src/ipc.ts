// Typed client for the Tauri IPC contract + an in-browser MOCK transport.
// Real transport = window.__TAURI_INTERNALS__ (same calls @tauri-apps/api@2 makes: core.invoke,
// core.transformCallback, plugin:event|listen). No npm @tauri-apps/api needed.
// The mock is picked automatically when __TAURI_INTERNALS__ is absent (npm run dev, screenshots).

export type Kind = 'step' | 'tool_call' | 'tool_result' | 'answer' | 'error' | 'done' | 'cancelled'
export type AgentState = 'thinking' | 'searching' | 'reading' | 'writing' | null
export interface AgentEvent {
  run_id: string
  seq: number
  ts: number | string // epoch ms (or s) or ISO string: the UI accepts all three
  kind: Kind
  state: AgentState
  text: string // plain French, safe for employees
  detail?: unknown // ADMIN ONLY (tool name/args/redacted result)
}
export interface AgentSettings { openrouter_key_set: boolean; model: string; model_options: string[] }
export interface CrmSession { signed_in: boolean; workspace: string }
export type Scenario = 'normal' | 'error' | 'signedout' | 'nokey'

export const EVENT_CHANNEL = 'agent://event'

interface Transport {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
  listen(cb: (e: AgentEvent) => void): void
}

type Internals = {
  invoke: (cmd: string, args?: Record<string, unknown>, opts?: unknown) => Promise<unknown>
  transformCallback: (cb: (e: { payload: AgentEvent }) => void, once?: boolean) => number
}
const tauri = (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__

/* ---------------- real transport ---------------- */
const realTransport = (T: Internals): Transport => ({
  invoke: <R,>(cmd: string, args?: Record<string, unknown>) => T.invoke(cmd, args) as Promise<R>,
  // Mirrors @tauri-apps/api@2.12 event.listen(): invoke('plugin:event|listen', {event, target:{kind:'Any'}, handler: transformCallback(fn)}).
  // The callback receives {event, id, payload}. We never unlisten: one listener for the window's lifetime.
  listen: cb => {
    T.invoke('plugin:event|listen', {
      event: EVENT_CHANNEL,
      target: { kind: 'Any' },
      handler: T.transformCallback(e => cb(e.payload)),
    }).catch(err => console.error('agent event listen failed', err))
  },
})

/* ---------------- mock transport (fictional data only) ---------------- */
const qs = new URLSearchParams(location.search)
const speed = Number(qs.get('mockspeed')) || 1
export const mockState = {
  scenario: ((qs.get('mock') as Scenario) || 'normal') as Scenario,
  key: qs.get('mock') !== 'nokey',
  model: 'meta-llama/llama-3.3-70b-instruct:free',
}
const MODELS = ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free', 'mistralai/mistral-small-3.2-24b-instruct:free']

type Draft = Omit<AgentEvent, 'run_id' | 'seq' | 'ts'> & { wait: number }
const e = (wait: number, kind: Kind, state: AgentState, text: string, detail?: unknown): Draft => ({ wait, kind, state, text, detail })

function script(task: string, scenario: Scenario): Draft[] {
  const head = [
    e(500, 'step', 'thinking', 'Je lis votre demande', { model: 'mock', task_chars: task.length }),
    e(1100, 'tool_call', 'searching', 'Je cherche dans le CRM', { tool: 'crm.find_conversations', args: { silentHours: '>24', limit: 20, q: '[masqué]' } }),
  ]
  if (scenario === 'error') {
    return [...head, e(1200, 'error', null, "Le service d'intelligence artificielle ne répond pas pour le moment. Rien n'a été modifié. Réessayez dans un instant.", { code: 'upstream_timeout', http: 504, provider: 'openrouter' })]
  }
  return [
    ...head,
    e(1200, 'tool_result', 'reading', "J'ai trouvé 5 conversations", { tool: 'crm.find_conversations', result: '5 conversations (noms et numéros masqués)', ms: 840 }),
    e(1400, 'step', 'reading', "Je relis les échanges de chaque client", { tool: 'crm.read_thread', args: { ids: ['c_91', 'c_44', 'c_12'] }, ms: 2100 }),
    e(1800, 'step', 'writing', 'Je rédige la réponse', { model: 'mock', tokens_out: 148 }),
    e(900, 'answer', null,
      "Voici où vous en êtes :\n\n• 5 conversations WhatsApp attendent une réponse (la plus ancienne : Sofia M., il y a 5 jours).\n• 3 visites demain, dont une à 10 h (villa de Californie).\n• 1 mandat attend une signature depuis 4 jours (M. Alami).\n\nJe peux détailler l'un de ces points si vous voulez. Je n'ai rien envoyé et rien modifié.",
      { tokens: 148 }),
    e(150, 'done', null, 'Terminé', { total_ms: 6900 }),
  ]
}

function mockTransport(): Transport {
  let cb: (e: AgentEvent) => void = () => {}
  const runs = new Map<string, { events: AgentEvent[]; timer?: ReturnType<typeof setTimeout>; seq: number }>()
  const emit = (id: string, d: Omit<Draft, 'wait'>) => {
    const r = runs.get(id)!
    const ev: AgentEvent = { run_id: id, seq: ++r.seq, ts: Date.now(), kind: d.kind, state: d.state, text: d.text, detail: d.detail }
    r.events.push(ev)
    cb(ev)
  }
  const play = (id: string, steps: Draft[]) => {
    const [h, ...rest] = steps
    if (!h) return
    const r = runs.get(id)!
    r.timer = setTimeout(() => { emit(id, h); play(id, rest) }, h.wait / speed)
  }
  const call = async (cmd: string, a: Record<string, unknown> = {}): Promise<unknown> => {
    await new Promise(r => setTimeout(r, 60))
    switch (cmd) {
      case 'agent_run': {
        const id = 'run_' + Math.random().toString(36).slice(2, 8)
        runs.set(id, { events: [], seq: 0 })
        play(id, script(String(a.task ?? ''), mockState.scenario))
        return id
      }
      case 'agent_cancel': {
        const r = runs.get(String(a.run_id))
        if (r && !r.events.some(x => ['done', 'error', 'cancelled'].includes(x.kind))) {
          clearTimeout(r.timer)
          emit(String(a.run_id), { kind: 'cancelled', state: null, text: "Arrêté. Rien n'a été modifié.", detail: { by: 'user' } })
        }
        return null
      }
      case 'agent_trace': return runs.get(String(a.run_id))?.events ?? []
      case 'agent_settings_get':
        return { openrouter_key_set: mockState.key, model: mockState.model, model_options: MODELS } satisfies AgentSettings
      case 'agent_settings_set':
        if (typeof a.openrouter_key === 'string' && a.openrouter_key) mockState.key = true
        if (typeof a.model === 'string' && MODELS.includes(a.model)) mockState.model = a.model
        return null
      case 'crm_session_status':
        return { signed_in: mockState.scenario !== 'signedout', workspace: '360annonces (démo)' } satisfies CrmSession
    }
    throw new Error('unknown command ' + cmd)
  }
  return { invoke: ((c: string, a?: Record<string, unknown>) => call(c, a)) as Transport['invoke'], listen: f => { cb = f } }
}

/* ---------------- public typed client ---------------- */
export const isMock = !tauri
const transport: Transport = tauri ? realTransport(tauri) : mockTransport()

const handlers = new Set<(e: AgentEvent) => void>()
let listening = false

// Rust commands use rename_all=snake_case: send run_id.
export const ipc = {
  run: (task: string) => transport.invoke<string>('agent_run', { task }),
  cancel: (runId: string) => transport.invoke<void>('agent_cancel', { run_id: runId }),
  trace: (runId: string) => transport.invoke<AgentEvent[]>('agent_trace', { run_id: runId }),
  settingsGet: () => transport.invoke<AgentSettings>('agent_settings_get'),
  // UNVERIFIED payload shape (contract only says "{openrouter_key?, model?}"): sent flat with both
  // spellings so it works whether Rust declares two args (camelCase default) or rename_all="snake_case".
  // If the Rust command takes ONE struct arg, it needs {<argname>: {...}} instead: change here only.
  settingsSet: (s: { openrouter_key?: string; model?: string }) => {
    const p: Record<string, unknown> = {}
    if (s.openrouter_key) { p.openrouter_key = s.openrouter_key; p.openrouterKey = s.openrouter_key }
    if (s.model) p.model = s.model
    return transport.invoke<void>('agent_settings_set', p)
  },
  session: () => transport.invoke<CrmSession>('crm_session_status'),
  onEvent(h: (e: AgentEvent) => void) {
    handlers.add(h)
    if (!listening) { listening = true; transport.listen(ev => handlers.forEach(f => f(ev))) }
    return () => { handlers.delete(h) }
  },
}
