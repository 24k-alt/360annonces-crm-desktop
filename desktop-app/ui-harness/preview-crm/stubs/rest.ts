// THROWAWAY STUB of twenty-client-sdk/rest: scenario picked with ?s=
const q = new URLSearchParams(location.search);
const s = q.get('s') ?? 'ok';

export class RestApiClientError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

// Not a scannable QR: just a believable-looking pattern.
function fakeQr() {
  const n = 29, m = 8;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let r = '';
  const finder = (x: number, y: number) => x < 8 && y < 8 || x >= n - 8 && y < 8 || x < 8 && y >= n - 8;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let on = rnd() > 0.52;
    if (finder(x, y)) {
      const fx = x % (n - 8 + (x >= n - 8 ? 0 : 0)), fy = y;
      const lx = x >= n - 8 ? x - (n - 8) : x, ly = y >= n - 8 ? y - (n - 8) : y;
      on = lx === 0 || lx === 6 || ly === 0 || ly === 6 || (lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4);
      if (lx === 7 || ly === 7) on = false;
      void fx; void fy;
    }
    if (on) r += `<rect x="${x * m}" y="${y * m}" width="${m}" height="${m}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n * m} ${n * m}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${r}</g></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

const caps = { dailyCap: 60, hourlyCap: 20 };
const baseStatus = { mode: 'capture', killSwitch: { active: false }, effectiveCaps: caps, sentLastHour: 0, sentLast24h: 0, newConversationsLast24h: 3, line: { warmup: { active: false } }, haltReason: null as string | null };

function wa(action: string) {
  if (s === 'loading') return new Promise(() => {});
  if (s === 'unknown') throw new RestApiClientError(502);
  if (s === 'forbidden') throw new RestApiClientError(403);
  const connected = ['connected', 'live', 'killed', 'paused'].includes(s);
  const health = { connected, authenticating: s === 'authenticating', qrExpired: false };
  let status: Record<string, unknown> = { ...baseStatus };
  if (s === 'live') status = { ...status, mode: 'reply', sentLastHour: 6, sentLast24h: 41, line: { warmup: { active: true } } };
  if (s === 'killed') status = { ...status, mode: 'reply', killSwitch: { active: true } };
  if (s === 'paused') status = { ...status, mode: 'reply', haltReason: '3 envois ratés d’affilée' };
  if (action === 'qr') {
    if (s === 'qrfail') throw new RestApiClientError(502);
    return { ok: true, qr: { connected, authenticating: false, qrExpired: false, image: s === 'noqr' ? null : fakeQr() } };
  }
  return { ok: true, legacy: true, health, policy: { status } };
}

function dash() {
  if (s === 'loading') return new Promise(() => {});
  if (s === 'error') throw new RestApiClientError(500);
  const metrics: Record<string, unknown> = {
    qualificationFunnel: { leads: 23, openDemands: 17, visitsRequested: 11, visitsScheduled: 8, visitsCompleted: 5 },
    visits: { scheduled: 8, completed: 5, completionRate: 62 },
    hotLeads: 6, unansweredClients: 5, pendingAiSuggestions: 3,
    alerts: { totalServices: 1, unhealthyServices: 1 },
    leadSources: { 'Site web': 9, WhatsApp: 8, Portails: 4, 'Bouche à oreille': 2 },
    agentWorkload: { Nadia: 14, Hamza: 9, Sara: 6 },
  };
  if (s === 'calm') { metrics.unansweredClients = 0; metrics.pendingAiSuggestions = 0; metrics.alerts = { totalServices: 1, unhealthyServices: 0 }; }
  if (s === 'empty') return { generatedAt: new Date().toISOString(), metrics: { qualificationFunnel: { leads: 0, openDemands: 0, visitsRequested: 0, visitsScheduled: 0, visitsCompleted: 0 }, visits: { scheduled: 0, completed: 0, completionRate: 0 }, hotLeads: 0, unansweredClients: 0, pendingAiSuggestions: 0, alerts: { totalServices: 0, unhealthyServices: 0 }, leadSources: {}, agentWorkload: {} } };
  if (s === 'partial') { metrics.unansweredClients = null; metrics.alerts = null; metrics.agentWorkload = null; }
  return { generatedAt: new Date().toISOString(), metrics };
}

export class RestApiClient {
  async get() { return []; }
  async patch() { return {}; }
  async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    await new Promise((r) => setTimeout(r, 120));
    if (path.includes('dashboard-summary')) return (await dash()) as T;
    if (path.includes('whatsapp-legacy-control')) return (await wa(String(body?.action))) as T;
    return {} as T;
  }
}
