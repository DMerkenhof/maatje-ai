// Praat met de modellen: OpenRouter, en optioneel Ollama op je eigen computer
// (ingesteld met LOCAL_BASE_URL, bijv. http://100.x.y.z:11434/v1).
// Lokale modellen krijgen in de app een id dat begint met "local/".

const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
// De key komt uit .env, of uit de app zelf (dan staat hij in de database).
const ENV_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
let KEY = ENV_KEY;

export const keySource = () => (ENV_KEY ? 'env' : KEY ? 'app' : null);
export function setApiKey(key) {
  if (ENV_KEY) return; // .env gaat voor
  KEY = String(key || '').trim();
  modelCache = { at: 0, models: null };
}

// Voor Ollama gebruiken we de eigen API (/api/chat), omdat we daar de contextlengte
// kunnen meegeven. Of je nu .../v1 invult of niet, maakt dus niet uit.
const LOCAL_ROOT = (process.env.LOCAL_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
const LOCAL_NUM_CTX = Number(process.env.LOCAL_NUM_CTX || 32768);
export const LOCAL_NAME = (process.env.LOCAL_NAME || 'Mac').trim();
export const LOCAL_PREFIX = 'local/';

export const hasKey = () => KEY.length > 0;
export const NO_KEY_MESSAGE = 'Er is nog geen OpenRouter-key. Vul hem in bij de modelkiezer of zet hem in .env';
export const hasLocal = () => LOCAL_ROOT.length > 0;
export const isLocalModel = (id) => typeof id === 'string' && id.startsWith(LOCAL_PREFIX);

const openrouterHeaders = () => ({
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
  'Content-Type': 'application/json',
  'X-Title': 'Maatje AI',
});

const localModelName = (id) => id.slice(LOCAL_PREFIX.length);

function requireLocal() {
  if (!hasLocal()) throw new Error('Er is geen lokaal model ingesteld (LOCAL_BASE_URL in .env)');
}

// ---------- Modellenlijsten ----------

// OpenRouter: een uur in het geheugen bewaard.
let modelCache = { at: 0, models: null };

export async function listModels({ force = false } = {}) {
  const fresh = Date.now() - modelCache.at < 60 * 60 * 1000;
  if (modelCache.models && fresh && !force) return modelCache.models;

  const res = await fetch(`${BASE}/models`, { headers: openrouterHeaders(), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Modellen ophalen mislukt (${res.status})`);
  const json = await res.json();

  const models = (json.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    context: m.context_length || null,
    // OpenRouter geeft prijzen in dollar per token; wij tonen per miljoen.
    priceIn: perMillion(m.pricing?.prompt),
    priceOut: perMillion(m.pricing?.completion),
    tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
    effort: effortInfo(m),
    created: m.created || 0,
  }));

  models.sort((a, b) => a.name.localeCompare(b.name));
  modelCache = { at: Date.now(), models };
  return models;
}

// Welke denkstanden ("effort") een model heeft. null = niet instelbaar.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function effortInfo(m) {
  const r = m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : null;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const canReason = Boolean(r) || params.includes('reasoning') || params.includes('include_reasoning');
  if (!canReason) return null;
  const mandatory = Boolean(r?.mandatory);
  let levels = Array.isArray(r?.supported_efforts) && r.supported_efforts.length
    ? r.supported_efforts.filter((e) => EFFORT_ORDER.includes(e))
    : ['none', 'low', 'medium', 'high'];
  if (mandatory) levels = levels.filter((e) => e !== 'none');
  levels.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (!levels.length) return null;
  return { levels, default: r?.default_effort || null, mandatory };
}

export function modelEffort(id) {
  return modelCache.models?.find((x) => x.id === id)?.effort || null;
}

// Kan dit model tools gebruiken (memory lezen, MCP, skills)?
export function modelSupportsTools(id) {
  if (isLocalModel(id)) return false;
  const m = modelCache.models?.find((x) => x.id === id);
  return Boolean(m?.tools);
}

// Hetzelfde voor een lokaal model: dat vragen we aan Ollama.
export async function localSupportsTools(id) {
  if (!isLocalModel(id) || !hasLocal()) return false;
  const caps = await localCapabilities(localModelName(id));
  return caps.includes('tools');
}

// Lokaal: elke keer opnieuw gevraagd, want je Mac kan aan of uit staan.
export async function listLocalModels() {
  if (!hasLocal()) return { status: 'off', name: LOCAL_NAME, models: [] };
  try {
    const res = await fetch(`${LOCAL_ROOT}/v1/models`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    const models = (json.data || [])
      .map((m) => ({ id: LOCAL_PREFIX + m.id, name: m.id, local: true, priceIn: 0, priceOut: 0, context: null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Per model opvragen of het kan nadenken (dan is het aan/uit te zetten).
    await Promise.all(models.map(async (m) => {
      const caps = await localCapabilities(m.name);
      m.thinking = caps.includes('thinking');
      m.tools = caps.includes('tools');
      m.effort = m.thinking ? { levels: ['none', 'on'], default: null, mandatory: false, local: true } : null;
    }));
    return { status: 'ok', name: LOCAL_NAME, models };
  } catch {
    return { status: 'offline', name: LOCAL_NAME, models: [] };
  }
}

const capCache = new Map();
async function localCapabilities(name) {
  if (capCache.has(name)) return capCache.get(name);
  try {
    const res = await fetch(`${LOCAL_ROOT}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const caps = Array.isArray(json.capabilities) ? json.capabilities : [];
    capCache.set(name, caps);
    return caps;
  } catch {
    return [];
  }
}

function perMillion(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 1000) / 1000;
}

// ---------- Denkblokken ----------

// Sommige open modellen zetten hun "nadenken" als <think>...</think> in de tekst.
// Dat filteren we eruit, zodat je alleen het antwoord ziet.
function thinkFilter() {
  let inThink = false;
  let carry = '';

  const partialSuffix = (s, tag) => {
    for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
      if (tag.startsWith(s.slice(-k))) return k;
    }
    return 0;
  };

  const push = (text) => {
    let s = carry + text;
    carry = '';
    let out = '';
    let thinking = false;
    while (s.length) {
      if (inThink) {
        thinking = true;
        const end = s.indexOf('</think>');
        if (end === -1) {
          const keep = partialSuffix(s, '</think>');
          carry = keep ? s.slice(-keep) : '';
          break;
        }
        s = s.slice(end + '</think>'.length);
        inThink = false;
      } else {
        const start = s.indexOf('<think>');
        if (start === -1) {
          const keep = partialSuffix(s, '<think>');
          out += keep ? s.slice(0, -keep) : s;
          carry = keep ? s.slice(-keep) : '';
          break;
        }
        out += s.slice(0, start);
        s = s.slice(start + '<think>'.length);
        inThink = true;
        thinking = true;
      }
    }
    return { out, thinking };
  };

  const flush = () => {
    const rest = inThink ? '' : carry;
    carry = '';
    return rest;
  };

  return { push, flush };
}

export const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// ---------- Streamen ----------

// Streamt een antwoord. Geeft events terug:
//   { type: 'delta', text }        een stukje tekst
//   { type: 'reasoning' }          het model denkt na (tekst daarvan tonen we niet)
//   { type: 'usage', usage }       tokens en kosten aan het eind
//   { type: 'tool_calls', calls }  het model wil een tool gebruiken
const IDLE_MS = 2 * 60 * 1000;

export async function* streamChat({ model, messages, tools, effort, signal }) {
  // Komt er twee minuten lang helemaal niks binnen (ook geen keep-alive),
  // dan breken we af in plaats van eeuwig te blijven wachten.
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), IDLE_MS);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), IDLE_MS);
  };
  const combined = AbortSignal.any([signal, idle.signal].filter(Boolean));
  const local = isLocalModel(model);
  const who = local ? `je ${LOCAL_NAME}` : 'OpenRouter';

  try {
    if (local) yield* streamOllama({ model, messages, tools, effort, signal: combined, resetTimer });
    else yield* streamOpenRouter({ model, messages, tools, effort, signal: combined, resetTimer });
  } catch (err) {
    if (idle.signal.aborted && !signal?.aborted) {
      throw new Error(`Twee minuten geen reactie van ${who}, gestopt`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Helper voor tekst met denkblokken eruit.
function textEmitter() {
  const filter = thinkFilter();
  let gotContent = false;
  function* push(text) {
    let { out, thinking } = filter.push(text);
    if (!gotContent) out = out.replace(/^\s+/, '');
    if (out) {
      gotContent = true;
      yield { type: 'delta', text: out };
    } else if (thinking) {
      yield { type: 'reasoning' };
    }
  }
  function* flush() {
    const rest = filter.flush();
    if (rest) yield* push(rest);
  }
  return { push, flush, got: () => gotContent };
}

async function* readLines(res, resetTimer) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetTimer();
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

async function* streamOpenRouter({ model, messages, tools, effort, signal, resetTimer }) {
  // Velden die met _ beginnen zijn alleen voor intern gebruik.
  const clean = messages.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_'))));
  const body = { model, messages: clean, stream: true };
  if (tools?.length) body.tools = tools;
  if (effort && effort !== 'default') body.reasoning = { effort };
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: openrouterHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`OpenRouter niet bereikbaar: ${err.cause?.code || err.message}`);
  }
  if (!res.ok) throw new Error(await readError(res, false));

  const text = textEmitter();
  const calls = []; // opgebouwd uit stukjes: { id, name, arguments }

  for await (const line of readLines(res, resetTimer)) {
    // Commentaarregels (": OPENROUTER PROCESSING") overslaan.
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;

    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }

    // Fout halverwege de stream: status is al 200, de fout zit in de chunk.
    if (chunk.error) throw new Error(chunk.error.message || 'Fout van het model');

    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};

    if (typeof delta.content === 'string' && delta.content.length) {
      yield* text.push(delta.content);
    } else if (delta.reasoning || delta.reasoning_content || delta.reasoning_details) {
      yield { type: 'reasoning' };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length;
        calls[i] = calls[i] || { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    }

    if (chunk.usage) yield { type: 'usage', usage: chunk.usage };

    if (choice?.finish_reason === 'error' && !text.got()) {
      throw new Error('Het model gaf een fout zonder antwoord');
    }
  }

  yield* text.flush();
  const real = calls.filter((c) => c && c.name);
  if (real.length) {
    yield {
      type: 'tool_calls',
      calls: real.map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || '{}' })),
    };
  }
}

// Ollama wil de argumenten van een tool als object, niet als tekst.
function argsObject(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

function ollamaMessage(m) {
  const out = { role: m.role, content: m.content || '' };
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({ function: { name: tc.function?.name, arguments: argsObject(tc.function?.arguments) } }));
  }
  if (m.role === 'tool' && m._name) out.tool_name = m._name;
  return out;
}

async function* streamOllama({ model, messages, tools, effort, signal, resetTimer }) {
  requireLocal();
  const body = {
    model: localModelName(model),
    messages: messages.map(ollamaMessage),
    stream: true,
    options: { num_ctx: LOCAL_NUM_CTX },
  };
  if (tools?.length) body.tools = tools;
  // Nadenken aan of uit, alleen als je dat zelf gekozen hebt.
  if (effort === 'none') body.think = false;
  else if (effort && effort !== 'default') body.think = true;

  const send = () => fetch(`${LOCAL_ROOT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  let res;
  try {
    res = await send();
    // Kan dit model niet nadenken, dan gewoon zonder die instelling opnieuw.
    if (!res.ok && res.status === 400 && 'think' in body) {
      const text = await res.text().catch(() => '');
      if (/think/i.test(text)) {
        delete body.think;
        res = await send();
      } else {
        throw new Error(`Je ${LOCAL_NAME} gaf fout 400: ${text.slice(0, 200)}`);
      }
    }
  } catch (err) {
    if (signal.aborted) throw err;
    if (err.message?.startsWith(`Je ${LOCAL_NAME} gaf fout`)) throw err;
    throw new Error(localDownMessage(err));
  }
  if (!res.ok) throw new Error(await readError(res, true));

  const text = textEmitter();
  const calls = [];
  for await (const line of readLines(res, resetTimer)) {
    let chunk;
    try { chunk = JSON.parse(line); } catch { continue; }
    if (chunk.error) throw new Error(`Fout van je ${LOCAL_NAME}: ${chunk.error}`);
    const msg = chunk.message || {};
    if (typeof msg.content === 'string' && msg.content.length) yield* text.push(msg.content);
    else if (msg.thinking) yield { type: 'reasoning' };
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc?.function?.name) continue;
        calls.push({
          id: tc.id || `call_${calls.length}`,
          name: tc.function.name,
          arguments: JSON.stringify(argsObject(tc.function.arguments)),
        });
      }
    }
    if (chunk.done) {
      yield {
        type: 'usage',
        usage: { prompt_tokens: chunk.prompt_eval_count || 0, completion_tokens: chunk.eval_count || 0 },
      };
      break;
    }
  }
  yield* text.flush();
  if (calls.length) yield { type: 'tool_calls', calls };
}

// ---------- Eén antwoord in één keer, als JSON (voor het bijwerken van memory) ----------

export async function completeJSON({ model, system, user, schema, timeoutMs = 10 * 60 * 1000 }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let raw = '';

  if (isLocalModel(model)) {
    requireLocal();
    let res;
    try {
      res = await fetch(`${LOCAL_ROOT}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: localModelName(model),
          messages,
          stream: false,
          format: schema || 'json',
          options: { num_ctx: LOCAL_NUM_CTX, temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = new Error(err.name === 'TimeoutError' ? `Je ${LOCAL_NAME} deed er te lang over` : localDownMessage(err));
      e.offline = err.name !== 'TimeoutError';
      throw e;
    }
    if (!res.ok) throw new Error(await readError(res, true));
    const json = await res.json();
    raw = json.message?.content || '';
  } else {
    if (!hasKey()) throw new Error(NO_KEY_MESSAGE);
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: openrouterHeaders(),
      body: JSON.stringify({ model, messages, stream: false, temperature: 0.1, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(await readError(res, false));
    const json = await res.json();
    raw = json.choices?.[0]?.message?.content || '';
  }

  return parseJSONLoose(stripThink(raw));
}

export function parseJSONLoose(s) {
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  throw new Error('Het model gaf geen geldige JSON terug');
}

// ---------- Foutmeldingen ----------

function localDownMessage(err) {
  const code = err.cause?.code || '';
  if (code === 'ECONNREFUSED') {
    return `Je ${LOCAL_NAME} is wel bereikbaar, maar Ollama neemt niet op. Draait Ollama, en staat het open voor het netwerk?`;
  }
  return `Je ${LOCAL_NAME} is niet bereikbaar. Staat hij aan, is hij wakker en is Tailscale verbonden?`;
}

async function readError(res, local) {
  const text = await res.text().catch(() => '');
  let msg = '';
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || '';
  } catch {}
  if (local) {
    const base = res.status === 404 ? `Dit model staat niet (meer) op je ${LOCAL_NAME}` : `Je ${LOCAL_NAME} gaf fout ${res.status}`;
    return msg ? `${base}: ${msg}` : base;
  }
  const hints = {
    401: 'API-key klopt niet',
    402: 'Tegoed op OpenRouter is op',
    429: 'Te veel verzoeken, probeer het zo nog eens',
  };
  const base = hints[res.status] || `OpenRouter gaf fout ${res.status}`;
  return msg ? `${base}: ${msg}` : base;
}
