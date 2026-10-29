// MCP: andere apps (Supabase, internet zoeken, ...) als tools voor het model.
//
// Per server bewaren we in de database: naam, adres, eventueel een sleutel,
// en na inloggen via de browser de OAuth-tokens. Die gaan nooit naar de browser.
// Lezen gaat vanzelf; tools die iets kunnen wijzigen vragen eerst toestemming.
import crypto from 'node:crypto';
import { Client, StreamableHTTPClientTransport, SSEClientTransport, auth } from '@modelcontextprotocol/client';

const KEY = 'mcpServers';
const CALL_TIMEOUT = 2 * 60 * 1000;
const CONNECT_TIMEOUT = 25 * 1000;

let store = null;
const runtime = new Map(); // id -> { client, status, error, tools, authUrl, instructions, connecting, lastTry }

// ---------- Opslag ----------

const loadAll = () => (store ? store.getSetting(KEY, []) : []);
const saveAll = (list) => store.setSetting(KEY, list);
const getServer = (id) => loadAll().find((s) => s.id === id) || null;

function updateServer(id, fn) {
  const list = loadAll();
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  fn(s);
  saveAll(list);
  return s;
}

function rt(id) {
  if (!runtime.has(id)) runtime.set(id, { client: null, status: 'off', error: null, tools: [], authUrl: null, instructions: '', connecting: null, lastTry: 0 });
  return runtime.get(id);
}

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mcp';
}

function uniqueId(base) {
  const ids = new Set(loadAll().map((s) => s.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ---------- Kant-en-klare servers ----------

// Haalt de project-ref uit een geplakte link uit het Supabase-dashboard, of neemt hem zoals hij is.
function supabaseRef(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/project\/([a-z0-9]{15,40})/i) || s.match(/^https?:\/\/([a-z0-9]{15,40})\.supabase\.co/i) || s.match(/^([a-z0-9]{15,40})$/i);
  if (!m) throw new Error('Dat lijkt geen project-ref. Die vind je in de link van je project: supabase.com/dashboard/project/<ref>');
  return m[1].toLowerCase();
}

function fromPreset(body) {
  const preset = body.preset;
  if (preset === 'supabase') {
    const ref = supabaseRef(body.projectRef);
    const readOnly = body.readOnly !== false;
    const url = new URL('https://mcp.supabase.com/mcp');
    if (ref) url.searchParams.set('project_ref', ref);
    if (readOnly) url.searchParams.set('read_only', 'true');
    url.searchParams.set('features', ref ? 'database,docs,debugging,development' : 'account,database,docs,debugging,development');
    const token = String(body.token || '').trim();
    return {
      name: 'Supabase',
      url: url.toString(),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      autoApprove: [],
      preset,
    };
  }
  if (preset === 'exa') {
    const key = String(body.token || '').trim();
    return {
      name: 'Internet',
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa',
      headers: key ? { 'x-api-key': key } : {},
      // Zoeken en pagina's lezen verandert niks, dus dat mag zonder te vragen.
      autoApprove: ['web_search_exa', 'web_fetch_exa'],
      preset,
    };
  }
  // Eigen server
  const name = String(body.name || '').trim();
  let url;
  try { url = new URL(String(body.url || '').trim()); } catch { throw new Error('Vul een geldig adres in, bijv. https://voorbeeld.nl/mcp'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Het adres moet met https:// beginnen');
  const headers = {};
  const value = String(body.token || '').trim();
  if (value) {
    const headerName = String(body.headerName || 'Authorization').trim() || 'Authorization';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName)) throw new Error('Ongeldige naam voor de header');
    headers[headerName] = headerName.toLowerCase() === 'authorization' && !/^(bearer|basic|token)\s/i.test(value) ? `Bearer ${value}` : value;
  }
  return { name: name || url.hostname, url: url.toString(), headers, autoApprove: [], preset: 'custom' };
}

// ---------- Inloggen (OAuth) ----------

function oauthProvider(id, r) {
  const get = () => getServer(id)?.oauth || {};
  const set = (patch) => updateServer(id, (s) => { s.oauth = { ...(s.oauth || {}), ...patch }; });
  return {
    get redirectUrl() { return get().redirectUrl; },
    get clientMetadata() {
      const redirect = get().redirectUrl;
      return {
        client_name: 'Maatje AI',
        redirect_uris: redirect ? [redirect] : [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state() {
      const state = crypto.randomBytes(16).toString('hex');
      set({ state });
      return state;
    },
    clientInformation: () => get().client,
    saveClientInformation: (client) => set({ client }),
    tokens: () => get().tokens,
    saveTokens: (tokens) => set({ tokens }),
    redirectToAuthorization: (url) => { r.authUrl = String(url); },
    saveCodeVerifier: (verifier) => set({ verifier }),
    codeVerifier: () => {
      const v = get().verifier;
      if (!v) throw new Error('Inlogpoging verlopen, probeer opnieuw');
      return v;
    },
    saveDiscoveryState: (discovery) => set({ discovery }),
    discoveryState: () => get().discovery,
    invalidateCredentials: (scope) => {
      const o = { ...get() };
      if (scope === 'all' || scope === 'tokens') delete o.tokens;
      if (scope === 'all' || scope === 'client') delete o.client;
      if (scope === 'all' || scope === 'verifier') delete o.verifier;
      if (scope === 'all' || scope === 'discovery') delete o.discovery;
      updateServer(id, (s) => { s.oauth = o; });
    },
  };
}

// Klaar met inloggen in de browser: code inwisselen voor tokens en verbinden.
export async function finishAuth(params) {
  const state = params.get('state') || '';
  const s = state ? loadAll().find((x) => x.oauth?.state === state) : null;
  if (!s) throw new Error('Deze inlogpoging is onbekend of verlopen. Probeer het opnieuw vanuit MCP.');
  if (params.get('error')) {
    throw new Error(params.get('error') === 'access_denied' ? 'Inloggen geannuleerd.' : `Inloggen lukte niet (${clip(params.get('error'), 60)}).`);
  }
  const code = params.get('code');
  if (!code) throw new Error('Geen code ontvangen van de inlogpagina.');
  const r = rt(s.id);
  const result = await auth(oauthProvider(s.id, r), {
    serverUrl: new URL(s.url),
    authorizationCode: code,
    iss: params.get('iss') || undefined,
  });
  updateServer(s.id, (x) => {
    if (x.oauth) { delete x.oauth.state; delete x.oauth.verifier; }
  });
  if (result !== 'AUTHORIZED') throw new Error('Inloggen is niet afgerond, probeer het opnieuw.');
  r.authUrl = null;
  await connect(s.id);
  return { id: s.id, name: s.name, status: rt(s.id).status, error: rt(s.id).error };
}

// ---------- Verbinden ----------

async function closeClient(r) {
  const c = r.client;
  r.client = null;
  if (c) { try { await c.close(); } catch {} }
}

function friendlyError(err) {
  const msg = String(err?.message || err || 'Onbekende fout');
  const code = err?.cause?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Adres niet gevonden. Klopt de URL, en heeft de Pi internet?';
  if (code === 'ECONNREFUSED') return 'De server neemt niet op (verbinding geweigerd).';
  if (/fetch failed/i.test(msg)) return `Server niet bereikbaar${code ? ` (${code})` : ''}.`;
  if (/\b401\b|unauthori[sz]ed/i.test(msg)) return 'De server weigert de toegang: sleutel of token klopt niet, of je moet opnieuw inloggen.';
  if (/\b403\b|forbidden/i.test(msg)) return 'De server weigert de toegang (403).';
  if (/\b404\b/.test(msg)) return 'Op dit adres staat geen MCP-server (404). Klopt de URL?';
  if (/timed? ?out|timeout/i.test(msg)) return 'De server reageerde niet op tijd.';
  return clip(msg, 300);
}

export function connect(id, { origin } = {}) {
  const r = rt(id);
  if (r.connecting) return r.connecting;
  r.connecting = (async () => {
    r.lastTry = Date.now();
    await closeClient(r);
    const s0 = getServer(id);
    if (!s0) { runtime.delete(id); return; }
    if (!s0.enabled) {
      r.status = 'off'; r.error = null; r.authUrl = null;
      return;
    }

    // Het adres waarop de browser na het inloggen terugkomt.
    if (origin && /^https?:\/\/[^/]+$/.test(origin)) {
      const redirectUrl = `${origin}/api/mcp/callback`;
      updateServer(id, (x) => {
        const o = x.oauth || {};
        // Ander adres dan bij de vorige registratie: opnieuw registreren bij de server.
        if (o.redirectUrl && o.redirectUrl !== redirectUrl) delete o.client;
        o.redirectUrl = redirectUrl;
        x.oauth = o;
      });
    }
    const s = getServer(id);

    r.status = 'connecting';
    r.error = null;
    r.authUrl = null;

    const hasHeaders = s.headers && Object.keys(s.headers).length > 0;
    const provider = hasHeaders ? undefined : oauthProvider(id, r);
    const opts = { authProvider: provider, requestInit: { headers: { ...(s.headers || {}) } } };
    const newClient = () => new Client({ name: 'Maatje AI', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

    let client = newClient();
    try {
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(s.url), opts), { timeout: CONNECT_TIMEOUT });
      } catch (err) {
        // Oudere servers praten nog via SSE.
        if (!r.authUrl && /\b(404|405)\b/.test(String(err?.message))) {
          try { await client.close(); } catch {}
          client = newClient();
          await client.connect(new SSEClientTransport(new URL(s.url), opts), { timeout: CONNECT_TIMEOUT });
        } else {
          throw err;
        }
      }
      r.client = client;
      r.instructions = clip(client.getInstructions() || '', 1500);
      r.tools = await fetchTools(client);
      r.status = 'ok';
    } catch (err) {
      try { await client.close(); } catch {}
      if (r.authUrl) {
        r.status = 'auth';
        r.error = null;
      } else if (provider && !getServer(id)?.oauth?.redirectUrl && /unauthori[sz]ed|\b401\b/i.test(String(err?.message))) {
        // Na een herstart zonder geldige tokens: opnieuw inloggen via de app.
        r.status = 'auth';
        r.error = null;
      } else {
        r.status = 'error';
        r.error = friendlyError(err);
        console.warn(`[mcp] ${s.name}: ${err?.message || err}`);
      }
    }
  })().finally(() => { r.connecting = null; });
  return r.connecting;
}

async function fetchTools(client) {
  const tools = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT });
    tools.push(...(res.tools || []));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

export function initMcp(s) {
  store = s;
  for (const server of loadAll()) if (server.enabled) connect(server.id).catch(() => {});
}

// Wacht kort op servers die nog aan het verbinden zijn (bijv. vlak na een herstart),
// en probeert mislukte servers af en toe opnieuw.
export async function ready(maxMs = 8000) {
  const waits = [];
  for (const s of loadAll()) {
    if (!s.enabled) continue;
    const r = rt(s.id);
    if (r.connecting) waits.push(r.connecting);
    else if (r.status === 'off') waits.push(connect(s.id));
    // Mislukt: elke vijf minuten op de achtergrond opnieuw proberen, zonder het antwoord op te houden.
    else if (r.status === 'error' && Date.now() - r.lastTry > 5 * 60 * 1000) connect(s.id).catch(() => {});
  }
  if (!waits.length) return;
  await Promise.race([Promise.allSettled(waits), new Promise((res) => setTimeout(res, maxMs))]);
}

// ---------- Beheer (voor de API) ----------

function maskUrl(u) {
  try {
    const url = new URL(u);
    for (const [k] of url.searchParams) if (/key|token|secret|pass/i.test(k)) url.searchParams.set(k, '•••');
    return url.toString();
  } catch {
    return u;
  }
}

function isReadOnly(t) {
  return t?.annotations?.readOnlyHint === true;
}

function autoApproved(s, t) {
  return isReadOnly(t) || (s.autoApprove || []).includes(t.name);
}

export function listPublic() {
  return loadAll().map((s) => {
    const r = rt(s.id);
    return {
      id: s.id,
      name: s.name,
      preset: s.preset || 'custom',
      url: maskUrl(s.url),
      enabled: Boolean(s.enabled),
      status: s.enabled ? (r.connecting ? 'connecting' : r.status === 'off' ? 'connecting' : r.status) : 'off',
      error: r.error,
      authUrl: r.authUrl,
      hasKey: Boolean(s.headers && Object.keys(s.headers).length),
      loggedIn: Boolean(s.oauth?.tokens),
      tools: (r.tools || []).map((t) => ({
        name: t.name,
        title: t.title || t.annotations?.title || '',
        description: clip(t.description || '', 240),
        readOnly: isReadOnly(t),
        auto: autoApproved(s, t),
      })),
    };
  });
}

export function publicOne(id) {
  return listPublic().find((s) => s.id === id) || null;
}

export async function addServer(body, { origin } = {}) {
  const cfg = fromPreset(body || {});
  const id = uniqueId(slugify(cfg.preset === 'exa' ? 'internet' : cfg.name));
  const list = loadAll();
  list.push({ id, ...cfg, enabled: true, oauth: null, created: Date.now() });
  saveAll(list);
  await connect(id, { origin });
  return publicOne(id);
}

export async function patchServer(id, body, { origin } = {}) {
  const s = getServer(id);
  if (!s) throw new Error('MCP-server niet gevonden');
  let reconnect = false;
  updateServer(id, (x) => {
    if (typeof body.name === 'string' && body.name.trim()) x.name = body.name.trim().slice(0, 40);
    if (typeof body.enabled === 'boolean' && body.enabled !== x.enabled) {
      x.enabled = body.enabled;
      reconnect = true;
    }
    if (body.autoApprove && typeof body.autoApprove === 'object') {
      const set = new Set(x.autoApprove || []);
      for (const [tool, on] of Object.entries(body.autoApprove)) {
        if (on) set.add(tool); else set.delete(tool);
      }
      x.autoApprove = [...set];
    }
  });
  if (reconnect) await connect(id, { origin });
  return publicOne(id);
}

export async function removeServer(id) {
  const r = runtime.get(id);
  if (r) await closeClient(r);
  runtime.delete(id);
  saveAll(loadAll().filter((s) => s.id !== id));
}

export async function logout(id) {
  updateServer(id, (s) => { s.oauth = s.oauth?.redirectUrl ? { redirectUrl: s.oauth.redirectUrl } : null; });
  const r = rt(id);
  await closeClient(r);
  r.tools = [];
  r.status = 'auth';
}

export function setAutoApprove(id, toolName, on = true) {
  updateServer(id, (s) => {
    const set = new Set(s.autoApprove || []);
    if (on) set.add(toolName); else set.delete(toolName);
    s.autoApprove = [...set];
  });
}

// ---------- Voor het model ----------

const fnSafe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

// Alle tools van verbonden servers, in het formaat van de chat-API.
// index: functienaam -> { serverId, serverName, tool }
export function toolsForModel({ compact = false } = {}) {
  const tools = [];
  const index = new Map();
  const servers = [];
  for (const s of loadAll()) {
    const r = runtime.get(s.id);
    if (!s.enabled || !r || r.status !== 'ok' || !r.client) continue;
    servers.push({ name: s.name, instructions: r.instructions, count: r.tools.length });
    const prefix = fnSafe(s.id).replace(/-/g, '_');
    for (const t of r.tools) {
      let fn = `${prefix}__${fnSafe(t.name)}`.slice(0, 64);
      while (index.has(fn) || fn === 'memory_read') fn = fn.slice(0, 60) + '_' + Math.floor(Math.random() * 99);
      const params = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object', properties: {} };
      delete params.$schema;
      if (!params.type) params.type = 'object';
      if (params.type === 'object' && !params.properties) params.properties = {};
      tools.push({
        type: 'function',
        function: {
          name: fn,
          description: clip(`[${s.name}] ${t.description || t.title || t.name}`, compact ? 500 : 1500),
          parameters: params,
        },
      });
      index.set(fn, { serverId: s.id, serverName: s.name, tool: t });
    }
  }
  return { tools, index, servers };
}

export function needsApproval(serverId, tool) {
  const s = getServer(serverId);
  if (!s) return true;
  return !autoApproved(s, tool);
}

function formatResult(res, maxChars) {
  const parts = [];
  for (const c of res?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource') parts.push(c.resource?.text ?? `[bestand: ${c.resource?.uri || 'onbekend'}]`);
    else if (c.type === 'resource_link') parts.push(`[link: ${c.uri}]`);
    else if (c.type === 'image') parts.push('[afbeelding, niet meegestuurd]');
    else if (c.type === 'audio') parts.push('[audio, niet meegestuurd]');
  }
  if (!parts.length && res?.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  let text = parts.join('\n\n').trim() || '(leeg resultaat)';
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n\n[ingekort: nog ${text.length - maxChars} tekens]`;
  return { text, isError: Boolean(res?.isError) };
}

export async function callTool(serverId, toolName, args, { signal, maxChars = 16000 } = {}) {
  const attempt = async () => {
    const r = rt(serverId);
    if (!r.client || r.status !== 'ok') await connect(serverId);
    if (!r.client || r.status !== 'ok') {
      throw new Error(r.status === 'auth' ? 'Opnieuw inloggen nodig (zie MCP in de zijbalk)' : r.error || 'MCP-server niet verbonden');
    }
    return r.client.callTool({ name: toolName, arguments: args || {} }, { timeout: CALL_TIMEOUT, signal });
  };
  let res;
  try {
    res = await attempt();
  } catch (err) {
    if (signal?.aborted) throw err;
    // Verbinding of sessie verlopen: één keer opnieuw verbinden en nog eens proberen.
    if (/session|closed|not connected|fetch failed|ECONNRESET|socket|\b40[04]\b/i.test(String(err?.message))) {
      await connect(serverId);
      res = await attempt();
    } else {
      throw err;
    }
  }
  return formatResult(res, maxChars);
}
