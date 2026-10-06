import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BorderBeam } from 'border-beam'
import { ThinkingOrb } from 'thinking-orbs'
import { BotAvatar } from 'bot-avatars'
import {
  IDEAS, INITIAL_APPROVALS, INITIAL_MEMORY, INITIAL_TASKS, STARTERS, tpl,
  type Approval, type Col, type Memory, type Role, type Starter, type Task,
} from './data'
import { isMock, mockState, type Scenario } from './ipc'
import {
  KeyCard, LoadErrorCard, Lock, Preview, ReadOnly, RunCard, SettingsPanel, SignedOutCard, useAgent, useOnline, type Agent,
} from './Live'

type View = 'today' | 'board' | 'approvals' | 'memory' | 'journal'
type Sim = 'normal' | 'empty' | 'error' | 'offline'
type Theme = 'light' | 'dark'

const STEP_MS = 2200
const ME: Record<Role, string> = { employee: 'Nadia (employée)', admin: 'Hamza (admin)' }
const COLS: { id: Col; label: string }[] = [
  { id: 'todo', label: 'À faire' }, { id: 'running', label: 'En cours' },
  { id: 'review', label: 'À valider' }, { id: 'done', label: 'Terminé' },
]
const q = new URLSearchParams(location.search)

function useReducedMotion() {
  const [r, setR] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = (e: MediaQueryListEvent) => setR(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return r
}

const ICONS: Record<string, string> = {
  today: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  board: 'M4 4h6v16H4zM14 4h6v9h-6z',
  approvals: 'M20 6 9 17l-5-5',
  memory: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM9 8h6M9 12h6',
  journal: 'M4 5h16M4 12h16M4 19h10',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  send: 'M5 12h14M13 6l6 6-6 6',
}
function Icon({ n, size = 16 }: { n: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[n]} />
    </svg>
  )
}

export function App() {
  const reduced = useReducedMotion()
  const [theme, setTheme] = useState<Theme>(() => (q.get('theme') as Theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  // Real app: no role in the IPC contract yet, so admin only via ?role=admin on the window URL (UI hint, NOT a security boundary).
  const [role, setRole] = useState<Role>(q.get('role') === 'admin' ? 'admin' : 'employee')
  const [sim, setSim] = useState<Sim>((q.get('sim') as Sim) || 'normal')
  const [view, setView] = useState<View>((q.get('view') as View) || 'today')
  const [tasks, setTasks] = useState<Task[]>(INITIAL_TASKS)
  const [approvals, setApprovals] = useState<Approval[]>(INITIAL_APPROVALS)
  const [memory, setMemory] = useState<Memory[]>(INITIAL_MEMORY)
  const [palette, setPalette] = useState(q.get('palette') === '1')
  const [drawer, setDrawer] = useState<{ id: string; details: boolean } | null>(q.get('drawer') ? { id: q.get('drawer')!, details: q.get('details') === '1' } : null)
  const [toast, setToast] = useState('')
  const heroInput = useRef<HTMLInputElement>(null)
  const agent = useAgent()
  const netOn = useOnline()
  const [ask, setAsk] = useState('')
  const [scenario, setScenario] = useState<Scenario>(mockState.scenario)
  const [settingsOpen, setSettingsOpen] = useState(q.get('settings') === '1')

  const online = sim !== 'offline' // mock pages only; the real loop uses agent.* and navigator.onLine
  const empty = sim === 'empty'
  const failed = sim === 'error'
  const visTasks = empty ? [] : tasks
  const visApprovals = empty ? [] : approvals
  const pending = visApprovals.filter(a => a.status === 'pending').length
  const running = online && visTasks.some(t => t.col === 'running')

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(id)
  }, [toast])
  useEffect(() => { if (role === 'employee' && view === 'journal') setView('today') }, [role, view])

  // Mock job engine. Real version: server job table + SSE. Here: one timer, one step at a time.
  const ref = useRef({ tasks, approvals })
  ref.current = { tasks, approvals }
  useEffect(() => {
    if (!online) return
    const id = setInterval(() => {
      const { tasks: ts, approvals: ap } = ref.current
      const born: Approval[] = []
      const next = ts.map((t): Task => {
        if (t.col === 'todo' && t.queued) return { ...t, col: 'running', queued: false, step: 0, when: 'Démarré à l\'instant' }
        if (t.col === 'running') {
          const T = tpl(t.tpl)
          if (t.step + 1 < T.steps.length) return { ...t, step: t.step + 1 }
          if (T.approvals && !t.replay) {
            T.approvals.forEach((a, i) => born.push({ ...a, id: `${t.id}-a${i}`, taskId: t.id, status: 'pending' }))
            return { ...t, col: 'review', step: T.steps.length, summary: T.summary, when: 'À l\'instant' }
          }
          return { ...t, col: 'done', step: T.steps.length, when: 'À l\'instant', summary: t.replay ? 'Rejeu à blanc terminé : aucun message créé.' : T.summary }
        }
        if (t.col === 'review') {
          const mine = ap.filter(a => a.taskId === t.id)
          if (mine.length && mine.every(a => a.status !== 'pending' && a.status !== 'sending')) {
            const n = (s: string) => mine.filter(a => a.status === s).length
            return { ...t, col: 'done', summary: `${n('sent')} envoyé(s), ${n('blocked')} bloqué(s) par les règles, ${n('rejected')} refusé(s).` }
          }
        }
        return t
      })
      setTasks(next)
      if (born.length) setApprovals(a => [...a, ...born])
    }, STEP_MS)
    return () => clearInterval(id)
  }, [online])

  const createTask = useCallback((tplId: string, title?: string, replay = false) => {
    const T = tpl(tplId)
    const t: Task = {
      id: 't' + Math.random().toString(36).slice(2, 7), title: (replay ? 'Rejeu : ' : '') + (title || T.title), col: online ? 'running' : 'todo',
      tpl: tplId, step: 0, when: online ? 'Démarré à l\'instant' : 'En attente de connexion', queued: !online, replay,
    }
    setTasks(ts => [t, ...ts])
    setPalette(false)
    setView('board')
    setToast(online ? `C'est lancé : « ${t.title} »` : `Hors ligne : « ${t.title} » partira dès le retour de la connexion.`)
  }, [online])

  // Real slice-1 entry point: command bar, starters, palette, ideas all land here.
  const runTask = useCallback(async (task: string) => {
    setPalette(false); setView('today')
    if (!agent.ready) { setToast("Terminez d'abord la configuration ci-dessous."); return }
    if (!navigator.onLine) { setToast('Pas de connexion internet : impossible de lancer la demande.'); return }
    const err = await agent.run(task)
    setToast(err ?? `C'est lancé : « ${task} »`)
  }, [agent])
  const pickStarter = (s: Starter) => {
    if (s.edit) { setPalette(false); setView('today'); setAsk(s.task); setTimeout(() => heroInput.current?.focus(), 0) } else runTask(s.task)
  }

  const decide = (id: string, status: 'sending' | 'rejected') => {
    setApprovals(a => a.map(x => (x.id === id ? { ...x, status } : x)))
    if (status === 'sending') {
      setToast('Accord noté. Le serveur vérifie maintenant les règles avant l\'envoi.')
      setTimeout(() => setApprovals(a => a.map(x => (x.id === id ? { ...x, status: x.policy === 'ok' ? 'sent' : 'blocked' } : x))), 1800)
    }
  }

  // Ctrl/Cmd+K: on "Aujourd'hui" focus the one big bar, elsewhere open the palette.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (view === 'today' && !drawer && heroInput.current) heroInput.current.focus()
        else setPalette(p => !p)
      }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [view, drawer])

  const nav: { id: View; label: string }[] = [
    { id: 'today', label: "Aujourd'hui" }, { id: 'board', label: 'Tâches' }, { id: 'approvals', label: 'À valider' },
    { id: 'memory', label: 'Mémoire' }, ...(role === 'admin' ? [{ id: 'journal' as View, label: 'Journal (admin)' }] : []),
  ]
  const common = { role, online, failed, empty, retry: () => setSim('normal') }

  return (
    <div className="shell">
      <aside className="side" aria-label="Menu principal">
        <div className="brand"><i aria-hidden="true" />Laya</div>
        <nav aria-label="Sections" style={{ display: 'grid', gap: 2 }}>
          {nav.map(n => (
            <button key={n.id} className="nav" aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>
              <Icon n={n.id} />{n.label}
              {n.id !== 'today' && <Preview />}
            </button>
          ))}
        </nav>
        <div className="proto">
          <b>{isMock ? 'Prototype (simulation)' : 'Aperçu'}</b>
          <span>{isMock ? 'Aucun service réel : tout est simulé.' : 'Les pages marquées « Aperçu » montrent des exemples fictifs. Seule la page d’accueil est réelle.'}</span>
          {isMock && (
            <label>Scénario de l'assistant
              <select value={scenario} onChange={e => { const v = e.target.value as Scenario; mockState.scenario = v; setScenario(v); agent.refresh() }}>
                <option value="normal">Normal</option><option value="error">Erreur du service</option>
                <option value="signedout">Non connecté au CRM</option>
              </select>
            </label>
          )}
          {isMock && (
            <label>Pages d'aperçu
              <select value={sim} onChange={e => setSim(e.target.value as Sim)}>
                <option value="normal">Normal</option><option value="empty">Vide</option>
                <option value="error">Erreur</option><option value="offline">Hors ligne</option>
              </select>
            </label>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          {view !== 'today' && (
            <button className="cmdbtn" onClick={() => setPalette(true)} aria-label="Que voulez-vous faire ? Ouvrir (Ctrl K)">
              <Icon n="search" /> Que voulez-vous faire ? <kbd>Ctrl K</kbd>
            </button>
          )}
          <span className="sp" />
          {isMock && (
            <div className="seg" role="group" aria-label="Rôle (démonstration)">
              <button aria-pressed={role === 'employee'} onClick={() => setRole('employee')}>Employé</button>
              <button aria-pressed={role === 'admin'} onClick={() => setRole('admin')}>Admin</button>
            </div>
          )}
          <button className="btn" onClick={() => setSettingsOpen(true)}>Réglages</button>
          <button className="btn" onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))} aria-label={theme === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre'}>
            {theme === 'dark' ? 'Clair' : 'Sombre'}
          </button>
        </header>

        <main className="content" id="main">
          {view !== 'today' && (
            <div className="banner warn" role="note" style={{ maxWidth: view === 'board' ? 1200 : 1040, margin: '0 auto 16px' }}>
              <div><b>Aperçu.</b> Cette page montre des exemples fictifs pour imaginer la suite. Rien ici n'est réel et rien n'est enregistré ni envoyé.</div>
            </div>
          )}
          {!online && view !== 'today' && (
            <div className="banner bad" role="status" style={{ maxWidth: 1040, margin: '0 auto 16px' }}>
              <div><b>Vous êtes hors ligne.</b> Laya est injoignable. Vos demandes sont gardées et partiront au retour de la connexion. Les approbations sont suspendues.</div>
            </div>
          )}
          {view === 'today' && <Today {...common} theme={theme} reduced={reduced} pending={pending} heroInput={heroInput} agent={agent} netOn={netOn}
            text={ask} setText={setAsk} onAsk={runTask} onStarter={pickStarter} goto={setView} />}
          {view === 'board' && <Board {...common} tasks={visTasks} approvals={visApprovals} reduced={reduced} theme={theme}
            open={(id, details) => setDrawer({ id, details })} goto={setView} onStart={t => setTasks(ts => ts.map(x => (x.id === t ? { ...x, col: 'running', step: 0, scheduled: undefined, when: 'Démarré à l\'instant' } : x)))} />}
          {view === 'approvals' && <Approvals {...common} approvals={visApprovals} tasks={tasks} decide={decide}
            edit={(id, text) => { setApprovals(a => a.map(x => (x.id === id ? { ...x, text, edited: true } : x))); setToast('Texte modifié. Il reste à approuver.') }} />}
          {view === 'memory' && <MemoryView {...common} memory={empty ? [] : memory} me={ME[role]}
            save={(m: Memory) => { setMemory(l => (l.some(x => x.id === m.id) ? l.map(x => (x.id === m.id ? m : x)) : [m, ...l])); setToast('Enregistré. Laya en tiendra compte dès la prochaine tâche.') }}
            remove={(id: string) => setMemory(l => l.filter(x => x.id !== id))} />}
          {view === 'journal' && <Journal {...common} tasks={visTasks} open={id => setDrawer({ id, details: true })} />}
        </main>
      </div>

      {palette && <Palette close={() => setPalette(false)} run={runTask} pick={pickStarter} />}
      {settingsOpen && <SettingsDialog agent={agent} close={() => setSettingsOpen(false)} />}
      {drawer && <Drawer task={tasks.find(t => t.id === drawer.id)} role={role} details={drawer.details && role === 'admin'}
        setDetails={d => setDrawer({ ...drawer, details: d })} close={() => setDrawer(null)} replay={(t: Task) => { setDrawer(null); createTask(t.tpl, t.title, true) }} />}
      <div className="sr-only" role="status" aria-live="polite">{toast}</div>
      {toast && <div className="toast" aria-hidden="true">{toast}</div>}
    </div>
  )
}

type Common = { role: Role; online: boolean; failed: boolean; empty: boolean; retry: () => void }

function ErrorState({ retry }: { retry: () => void }) {
  return (
    <div className="empty page" role="alert">
      <b>Impossible d'afficher cette page</b>
      <span>Laya n'a pas répondu. Vos données ne sont pas perdues.</span>
      <button className="btn primary" onClick={retry}>Réessayer</button>
    </div>
  )
}
function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <div className="empty"><b>{title}</b><span>{text}</span>{children}</div>
}

/* ---------- Aujourd'hui ---------- */
function Today(p: Common & { theme: Theme; reduced: boolean; pending: number; heroInput: React.RefObject<HTMLInputElement | null>; agent: Agent; netOn: boolean; text: string; setText: (t: string) => void; onAsk: (t: string) => void; onStarter: (s: Starter) => void; goto: (v: View) => void }) {
  const { agent: a, text, setText } = p
  const [dismissed, setDismissed] = useState<string[]>([])
  const [why, setWhy] = useState<string | null>(null)
  const ideas = p.empty ? [] : IDEAS.filter(i => !dismissed.includes(i.id))
  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  const setup = a.loadErr ? 'error' : !a.session || !a.settings ? 'loading' : !a.session.signed_in ? 'signedout' : !a.settings.openrouter_key_set ? 'nokey' : null
  const canAsk = a.ready && p.netOn
  const state = setup ? 'setup' : !p.netOn ? 'off' : a.running ? 'work' : 'idle'
  const label = { setup: setup === 'loading' ? 'Chargement…' : 'Configuration à terminer', off: 'Pas de connexion internet', work: 'Laya travaille sur votre demande', idle: 'Laya est disponible' }[state]
  const placeholder = canAsk ? 'Que voulez-vous faire ? Ex. : quelles conversations attendent une réponse ?' : setup ? "Terminez d'abord la configuration ci-dessous" : 'Reconnectez-vous à internet pour continuer'
  const submit = () => { if (text.trim() && canAsk) { p.onAsk(text.trim()); setText('') } }
  return (
    <div className="page">
      <div className="hero">
        <BotAvatar type="clover" size={64} state={a.running ? 'working' : 'default'} paused={p.reduced || state === 'off' || state === 'setup'} aria-hidden="true" />
        <div>
          <h1>Bonjour</h1>
          <div className="status">
            <span className={`dot ${state}`} aria-hidden="true" />
            <span>{label} · <span style={{ textTransform: 'capitalize' }}>{date}</span>{a.session?.signed_in && a.session.workspace ? ` · ${a.session.workspace}` : ''}</span>
          </div>
        </div>
      </div>

      {!p.netOn && <div className="banner bad" role="status"><div><b>Pas de connexion internet.</b> Laya ne peut pas répondre tant que la connexion n'est pas revenue. Relancez votre demande ensuite.</div></div>}

      <section aria-label="Que voulez-vous faire ?" style={{ display: 'grid', gap: 12 }}>
        <BorderBeam size="line" colorVariant="ocean" theme={p.theme} active={a.running && !p.reduced} style={{ borderRadius: 12 }}>
          <form className="askbar" aria-busy={a.running} onSubmit={e => { e.preventDefault(); submit() }}>
            <Icon n="search" size={18} />
            <input ref={p.heroInput} value={text} disabled={!canAsk} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setText(''); e.currentTarget.blur() } }}
              aria-label="Que voulez-vous faire ?" placeholder={placeholder} />
            <kbd aria-hidden="true">Ctrl K</kbd>
            <button className="btn primary" type="submit" disabled={!text.trim() || !canAsk}>Lancer</button>
          </form>
        </BorderBeam>
        <div><ReadOnly /></div>
        {setup === 'error' && <LoadErrorCard retry={a.refresh} />}
        {setup === 'signedout' && <SignedOutCard recheck={a.refresh} workspaceHint={a.session?.workspace} />}
        {setup === 'nokey' && a.settings && <KeyCard settings={a.settings} onSaved={a.refresh} />}
        <div className="starters">
          {STARTERS.map(s => (
            <button key={s.id} className="starter" disabled={!canAsk} onClick={() => p.onStarter(s)}>
              <b>{s.title}</b><span>{s.hint}</span>
            </button>
          ))}
        </div>
      </section>

      {a.runs.length > 0 && (
        <section aria-labelledby="runs-h" style={{ display: 'grid', gap: 12 }}>
          <div className="sectionhead"><h2 id="runs-h">Vos demandes</h2><span>Les réponses ne sont pas conservées si vous fermez la fenêtre.</span></div>
          {a.runs.slice(0, 5).map(r => (
            <RunCard key={r.id} run={r} admin={p.role === 'admin'} theme={p.theme} reduced={p.reduced}
              cancel={() => a.cancel(r.id)} retry={() => p.onAsk(r.task)} />
          ))}
        </section>
      )}

      <section aria-labelledby="ideas-h">
        <div className="sectionhead"><h2 id="ideas-h">Idées du jour</h2><Preview /><span>Exemples fictifs. Laya ne regarde pas encore votre agence toute seule.</span></div>
        {ideas.length === 0 ? (
          <Empty title={p.empty ? "Pas encore d'idées" : 'Vous avez tout vu pour le moment'} text="Laya vous proposera de nouvelles idées demain matin, ou si quelque chose d'important arrive." />
        ) : (
          <div className="ideas">
            {ideas.map(i => (
              <article key={i.id} className="card idea">
                <h3>{i.title}</h3>
                <p className="muted">{i.body}</p>
                {why === i.id && <p className="why" id={`why-${i.id}`}>{i.why}</p>}
                <div className="acts">
                  <button className="btn sm primary" disabled={!canAsk} onClick={() => { p.onAsk(i.task); setDismissed(d => [...d, i.id]) }}>{i.action}</button>
                  <button className="btn sm ghost" aria-expanded={why === i.id} aria-controls={`why-${i.id}`} onClick={() => setWhy(why === i.id ? null : i.id)}>Pourquoi ?</button>
                  <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => setDismissed(d => [...d, i.id])}>Pas maintenant</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="num-h">
        <div className="sectionhead"><h2 id="num-h">Les chiffres qui comptent</h2><Preview /><span>Exemples fictifs, pas vos vrais chiffres.</span></div>
        <div className="stats">
          <div className="stat"><strong>{p.empty ? 0 : 7}</strong><span>Nouveaux contacts WhatsApp</span></div>
          <div className="stat"><strong>{p.empty ? 0 : 5}</strong><span>Conversations sans réponse</span></div>
          <div className="stat"><strong>{p.empty ? 0 : 3}</strong><span>Visites demain</span></div>
          <div className="stat"><strong>{p.pending}</strong><span>À valider par vous</span></div>
        </div>
      </section>
    </div>
  )
}

/* ---------- Tâches ---------- */
function Board(p: Common & { tasks: Task[]; approvals: Approval[]; reduced: boolean; theme: Theme; open: (id: string, d: boolean) => void; goto: (v: View) => void; onStart: (id: string) => void }) {
  if (p.failed) return <ErrorState retry={p.retry} />
  // Only the first running card gets a beam: many beams repaint every frame (skill: avoid many instances).
  const beamId = p.online && !p.reduced ? p.tasks.find(t => t.col === 'running')?.id : undefined
  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="pagehead"><div><h1>Tâches</h1><p>Chaque demande devient une carte. Laya la fait avancer de gauche à droite.</p></div></div>
      {p.empty && <Empty title="Aucune tâche pour le moment" text="Tapez ce que vous voulez faire dans la barre en haut, ou choisissez une idée sur « Aujourd'hui »." />}
      <div className="board">
        {COLS.map(c => {
          const list = p.tasks.filter(t => t.col === c.id)
          return (
            <section key={c.id} className="col" aria-label={`${c.label}, ${list.length} tâche(s)`}>
              <header>{c.label}<span className="chip">{list.length}</span></header>
              {list.length === 0 && <div className="colempty">Rien ici</div>}
              {list.map(t => {
                const T = tpl(t.tpl)
                const cur = T.steps[Math.min(t.step, T.steps.length - 1)]
                const mine = p.approvals.filter(a => a.taskId === t.id && a.status === 'pending').length
                const card = (
                  <article className="card tcard" style={{ borderRadius: 8 }}>
                    <button className="title" onClick={() => p.open(t.id, false)}>{t.title}</button>
                    {t.replay && <span className="chip warn" style={{ justifySelf: 'start' }}>Rejeu à blanc</span>}
                    {t.col === 'running' && (
                      <>
                        <div className="stepnow" role="status">
                          {p.online
                            ? <ThinkingOrb state={cur.orb} size={20} theme={p.theme} aria-hidden="true" />
                            : <span className="dot off" aria-hidden="true" />}
                          <span>{p.online ? cur.label : 'En pause : hors ligne'}</span>
                        </div>
                        <div className="bar" aria-hidden="true">{T.steps.map((_, i) => <i key={i} className={i <= t.step ? 'on' : ''} />)}</div>
                        <span className="small muted">Étape {Math.min(t.step + 1, T.steps.length)} sur {T.steps.length}</span>
                      </>
                    )}
                    {t.col === 'todo' && (
                      <>
                        <span className="small muted">{t.queued ? 'En attente de connexion' : `Prévu à ${t.scheduled}`}</span>
                        {!t.queued && <button className="btn sm" style={{ justifySelf: 'start' }} disabled={!p.online} onClick={() => p.onStart(t.id)}>Lancer maintenant</button>}
                      </>
                    )}
                    {t.col === 'review' && (
                      <>
                        <span className="small muted">{mine > 0 ? `${mine} élément(s) attendent votre accord` : 'Envoi en cours de vérification'}</span>
                        <button className="btn sm primary" style={{ justifySelf: 'start' }} onClick={() => p.goto('approvals')}>Voir et valider</button>
                      </>
                    )}
                    {t.col === 'done' && <span className="small muted">{t.summary}</span>}
                    {!(t.col === 'todo' && !t.queued) && <span className="small muted">{t.when}</span>}
                  </article>
                )
                return beamId === t.id
                  ? <BorderBeam key={t.id} size="md" colorVariant="ocean" theme={p.theme} strength={0.8} style={{ borderRadius: 8 }}>{card}</BorderBeam>
                  : <div key={t.id}>{card}</div>
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- À valider ---------- */
const KIND = { whatsapp: 'Message WhatsApp', email: 'E-mail', crm: 'Changement dans le CRM' }
const BLOCK = {
  window: "Ce client ne vous a pas écrit depuis plus de 72 h : WhatsApp n'autorise pas de lui écrire en premier. Appelez-le ou envoyez-lui un e-mail.",
  quiet: "Heures calmes de l'agence (21 h à 9 h). Le message ne part pas la nuit.",
  ok: '',
}
function StatusChip({ s }: { s: Approval['status'] }) {
  const m = {
    pending: ['blue', 'En attente de votre accord'], sending: ['warn', "En attente du serveur (vérification des règles)"],
    sent: ['ok', 'Envoyé'], blocked: ['bad', 'Bloqué par les règles'], rejected: ['', 'Refusé par vous'],
  }[s]
  return <span className={`chip ${m[0]}`}>{m[1]}</span>
}
function Approvals(p: Common & { approvals: Approval[]; tasks: Task[]; decide: (id: string, s: 'sending' | 'rejected') => void; edit: (id: string, t: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  if (p.failed) return <ErrorState retry={p.retry} />
  const todo = p.approvals.filter(a => a.status === 'pending')
  const rest = p.approvals.filter(a => a.status !== 'pending')
  return (
    <div className="page">
      <div className="pagehead"><div><h1>À valider</h1><p>Laya prépare, vous décidez. Rien ne part sans votre accord.</p></div></div>
      <div className="banner" role="note">
        <div><b>Approuver ne veut pas dire « envoyé ».</b> Votre accord est transmis au serveur, qui vérifie encore les règles de l'agence (heures calmes, premier contact, ligne WhatsApp). Il peut bloquer l'envoi : vous le verrez ici, honnêtement.</div>
      </div>
      {todo.length === 0 && <Empty title={p.empty ? 'Rien à valider' : 'Tout est à jour'} text="Quand Laya aura écrit un message ou voulu modifier une fiche, vous le verrez ici avant tout envoi." />}
      <div className="alist">
        {todo.map(a => (
          <article key={a.id} className="card acard">
            <header><h3>{KIND[a.kind]}</h3><StatusChip s={a.status} />{a.edited && <span className="chip">Modifié par vous</span>}</header>
            <div className="to">{a.kind === 'crm' ? 'Où : ' : 'À : '}<b style={{ color: 'var(--fg)', fontWeight: 500 }}>{a.to}</b></div>
            {editing === a.id ? (
              <textarea autoFocus aria-label="Modifier le texte" value={draft} onChange={e => setDraft(e.target.value)} />
            ) : a.kind === 'crm' ? (
              <div className="crmrow"><span className="muted">{a.field}</span><span><span className="old">{a.before}</span> → <b>{a.text}</b></span></div>
            ) : <div className="quote">{a.text}</div>}
            <p className="small muted"><b>Pourquoi :</b> {a.why}</p>
            {editing === a.id ? (
              <div className="acts">
                <button className="btn primary" onClick={() => { p.edit(a.id, draft.trim() || a.text); setEditing(null) }}>Enregistrer</button>
                <button className="btn" onClick={() => setEditing(null)}>Annuler</button>
              </div>
            ) : (
              <div className="acts">
                <button className="btn primary" disabled={!p.online} onClick={() => p.decide(a.id, 'sending')}>Approuver</button>
                <button className="btn" onClick={() => { setEditing(a.id); setDraft(a.text) }}>Modifier</button>
                <button className="btn danger" disabled={!p.online} onClick={() => p.decide(a.id, 'rejected')}>Refuser</button>
                <span className="small muted">{p.online ? 'Votre accord ne garantit pas l\'envoi.' : 'Reconnectez-vous pour décider.'}</span>
              </div>
            )}
          </article>
        ))}
      </div>
      {rest.length > 0 && (
        <section aria-labelledby="done-h">
          <div className="sectionhead"><h2 id="done-h">Déjà traités</h2></div>
          <div className="card" style={{ padding: '4px 12px' }}>
            {rest.map(a => (
              <div key={a.id} className="done-row" style={{ alignItems: 'flex-start' }}>
                <div className="t" style={{ whiteSpace: 'normal' }}>
                  <b style={{ fontWeight: 500 }}>{KIND[a.kind]}</b> · <span className="muted">{a.to}</span>
                  {a.status === 'blocked' && <div className="small" style={{ color: 'var(--bad)' }}>{BLOCK[a.policy]}</div>}
                  {a.status === 'sending' && <div className="small muted">Le serveur contrôle les règles…</div>}
                </div>
                <StatusChip s={a.status} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/* ---------- Mémoire ---------- */
function MemoryView(p: Common & { memory: Memory[]; me: string; save: (m: Memory) => void; remove: (id: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState<Memory['kind']>('Règle')
  const [add, setAdd] = useState('')
  if (p.failed) return <ErrorState retry={p.retry} />
  return (
    <div className="page">
      <div className="pagehead"><div><h1>Mémoire</h1><p>Ce que Laya sait de votre agence. Elle relit cette liste avant chaque tâche.</p></div></div>
      <form className="addrow" onSubmit={e => { e.preventDefault(); if (add.trim()) { p.save({ id: 'm' + Date.now(), kind, text: add.trim(), by: p.me, at: "à l'instant" }); setAdd('') } }}>
        <select aria-label="Type" value={kind} onChange={e => setKind(e.target.value as Memory['kind'])}><option>Règle</option><option>Info</option></select>
        <input type="text" value={add} onChange={e => setAdd(e.target.value)} aria-label="Nouvelle règle ou information" placeholder="Ajouter une règle ou une information. Ex. : Toujours proposer deux horaires de visite" />
        <button className="btn primary" type="submit" disabled={!add.trim()}>Ajouter</button>
      </form>
      {p.memory.length === 0 ? (
        <Empty title="Laya ne sait encore rien" text="Ajoutez vos règles (ton, horaires, interdits) : elles seront respectées dès la prochaine tâche." />
      ) : (
        <div className="panel">
          {p.memory.map(m => (
            <div key={m.id} className="mrow">
              <span className={`chip ${m.kind === 'Règle' ? 'blue' : ''}`}>{m.kind}</span>
              <div className="body">
                {editing === m.id
                  ? <input type="text" autoFocus aria-label="Modifier" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(null) }} />
                  : <div>{m.text}</div>}
                <div className="small muted">Modifié par {m.by}, {m.at}</div>
              </div>
              {editing === m.id ? (
                <>
                  <button className="btn sm primary" onClick={() => { p.save({ ...m, text: draft.trim() || m.text, by: p.me, at: "à l'instant" }); setEditing(null) }}>Enregistrer</button>
                  <button className="btn sm" onClick={() => setEditing(null)}>Annuler</button>
                </>
              ) : (
                <>
                  <button className="btn sm" onClick={() => { setEditing(m.id); setDraft(m.text) }} aria-label={`Modifier : ${m.text}`}>Modifier</button>
                  <button className="btn sm ghost" onClick={() => p.remove(m.id)} aria-label={`Supprimer : ${m.text}`}>Supprimer</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- Journal (admin) ---------- */
function Journal(p: Common & { tasks: Task[]; open: (id: string) => void }) {
  if (p.failed) return <ErrorState retry={p.retry} />
  return (
    <div className="page">
      <div className="pagehead"><div><h1>Journal des exécutions</h1><p>Réservé aux administrateurs. Sert à comprendre, corriger ou rejouer une tâche.</p></div></div>
      <div className="banner warn" role="note"><div>Les numéros, e-mails et noms sont masqués dans toutes les traces. L'affichage brut est désactivé.</div></div>
      {p.tasks.length === 0 ? <Empty title="Aucune exécution" text="Les tâches lancées apparaîtront ici avec leurs étapes techniques." /> : (
        <div className="panel">
          <table>
            <thead><tr><th>Tâche</th><th>Quand</th><th>Étapes</th><th>Durée</th><th>État</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {p.tasks.map(t => {
                const T = tpl(t.tpl)
                const done = T.steps.slice(0, t.step)
                return (
                  <tr key={t.id}>
                    <td>{t.title}</td><td className="muted">{t.when}</td><td>{done.length}/{T.steps.length}</td>
                    <td className="mono">{(done.reduce((s, x) => s + x.ms, 0) / 1000).toFixed(1)} s</td>
                    <td><span className="chip">{COLS.find(c => c.id === t.col)!.label}</span></td>
                    <td><button className="btn sm" onClick={() => p.open(t.id)}>Détails</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ---------- Tiroir d'une tâche ---------- */
function useDialog(close: () => void) {
  const box = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current() }
      if (e.key === 'Tab' && box.current) { // keep focus inside the dialog
        const f = [...box.current.querySelectorAll<HTMLElement>('button,input,textarea,select,[tabindex="0"]')].filter(x => !x.hasAttribute('disabled'))
        if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    addEventListener('keydown', on, true)
    return () => { removeEventListener('keydown', on, true); prev?.focus() }
  }, [])
  return box
}

function Drawer({ task, role, details, setDetails, close, replay }: { task?: Task; role: Role; details: boolean; setDetails: (d: boolean) => void; close: () => void; replay: (t: Task) => void }) {
  const box = useDialog(close)
  const T = task && tpl(task.tpl)
  return (
    <div className="scrim right" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Détail de la tâche" ref={box}>
        <header>
          <h2>{task?.title ?? 'Tâche introuvable'}</h2>
          <button className="btn sm" data-autofocus onClick={close}>Fermer</button>
        </header>
        {task && T && (
          <div className="dbody">
            <div className="acts"><span className="chip blue">{COLS.find(c => c.id === task.col)!.label}</span><span className="small muted">{task.when}</span></div>
            {task.summary && <p>{task.summary}</p>}
            <ol className="steps" aria-label="Étapes">
              {T.steps.map((s, i) => {
                const st = i < task.step ? 'done' : i === task.step && task.col === 'running' ? 'now' : 'todo'
                return (
                  <li key={i} className={st}>
                    <span className="ic" aria-hidden="true">
                      {st === 'done' ? <Icon n="approvals" size={14} /> : st === 'now' ? <ThinkingOrb state={s.orb} size={20} aria-hidden="true" /> : '·'}
                    </span>
                    <span>{s.label}<span className="sr-only">{st === 'done' ? ' (fait)' : st === 'now' ? ' (en cours)' : ' (à venir)'}</span></span>
                  </li>
                )
              })}
            </ol>
            {role === 'admin' && (
              <div style={{ display: 'grid', gap: 12 }}>
                <div className="acts">
                  <button className="btn" aria-pressed={details} onClick={() => setDetails(!details)}>{details ? 'Masquer les détails' : 'Détails'}</button>
                  <button className="btn" disabled={task.col === 'running'} onClick={() => replay(task)} title="Relance les mêmes étapes sans rien créer ni envoyer">Rejouer à blanc</button>
                </div>
                {details && (
                  <div className="panel">
                    <table className="trace">
                      <thead><tr><th>Outil</th><th>Paramètres (masqués)</th><th>Résultat</th><th>ms</th></tr></thead>
                      <tbody>
                        {T.steps.slice(0, task.step).map((s, i) => (
                          <tr key={i}><td><code>{s.tool}</code></td><td><code>{s.args}</code></td><td>{s.out}</td><td className="mono">{s.ms}</td></tr>
                        ))}
                        {task.step === 0 && <tr><td colSpan={4} className="muted">Aucun appel pour l'instant.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- Palette Ctrl/Cmd+K (hors « Aujourd'hui ») ---------- */
function Palette({ close, run, pick }: { close: () => void; run: (task: string) => void; pick: (s: Starter) => void }) {
  const box = useDialog(close)
  const [text, setText] = useState('')
  const [i, setI] = useState(0)
  const items = useMemo(() => {
    const t = text.trim().toLowerCase()
    const list = STARTERS.filter(s => !t || s.title.toLowerCase().includes(t)).map(s => ({ key: s.id, title: s.title, sub: s.hint, run: () => pick(s) }))
    return t ? [{ key: 'free', title: `Lancer : « ${text.trim()} »`, sub: 'Laya cherche et répond, sans rien envoyer ni modifier', run: () => run(text.trim()) }, ...list] : list
  }, [text, run, pick])
  useEffect(() => setI(0), [text])
  return (
    <div className="scrim top" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Que voulez-vous faire ?" ref={box}>
        <input data-autofocus role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={items[i] ? `pal-${items[i].key}` : undefined}
          aria-label="Que voulez-vous faire ?" placeholder="Que voulez-vous faire ?" value={text} autoComplete="off"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(x + 1, items.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(x - 1, 0)) }
            if (e.key === 'Enter' && items[i]) items[i].run()
          }} />
        {!text && <div className="ph">Pour commencer</div>}
        <ul id="pal-list" role="listbox" aria-label="Actions">
          {items.length === 0 && <li role="option" aria-selected="false">Aucune action ne correspond</li>}
          {items.map((it, n) => (
            <li key={it.key} id={`pal-${it.key}`} role="option" aria-selected={n === i} onMouseEnter={() => setI(n)} onClick={it.run}>
              {it.title}<small>{it.sub}</small>
            </li>
          ))}
        </ul>
        <div className="ph" style={{ borderTop: '1px solid var(--line)', padding: '8px 12px' }}><ReadOnly compact /></div>
      </div>
    </div>
  )
}

function SettingsDialog({ agent, close }: { agent: Agent; close: () => void }) {
  const box = useDialog(close)
  return (
    <div className="scrim top" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="palette" style={{ padding: 16, gap: 12 }} role="dialog" aria-modal="true" aria-label="Réglages de l'assistant" ref={box}>
        <div className="acts" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 15 }}>Réglages de l'assistant</h2>
          <button className="btn sm" data-autofocus onClick={close}>Fermer</button>
        </div>
        {agent.settings ? <SettingsPanel settings={agent.settings} onSaved={agent.refresh} /> : <p className="muted">Chargement…</p>}
        <div className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Lock />Lecture seule : l'assistant ne peut rien envoyer ni modifier.</div>
      </div>
    </div>
  )
}
