// Eigen chat: de server. Serveert de pagina en de API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import { openDb } from './db.js';
import * as mem from './memory.js';
import { listModels, listLocalModels, hasKey, isLocalModel, setApiKey, keySource, NO_KEY_MESSAGE } from './openrouter.js';
import { startGeneration, stopGeneration, subscribe, isGenerating, liveState, onGenerationDone, answerApproval } from './generate.js';
import { startMemoryWorker, writerState, memoryModel, memoryEnabled, applyProposal } from './memory-writer.js';
import * as mcp from './mcp.js';
import * as skills from './skills.js';
import * as auth from './auth.js';
import * as vault from './vault.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appRoot);

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch {
  console.error(`Kan niet schrijven in ${DATA_DIR}.`);
  console.error('Op de Pi oplossen met: sudo chown -R 1000:1000 data (in de map van de app)');
  process.exit(1);
}

const store = openDb(DATA_DIR);
vault.initVault(store);
mem.ensureMemoryDirs(DATA_DIR);
mcp.initMcp(store);
if (!hasKey()) setApiKey(store.getSetting('openrouterKey', ''));
skills.initSkills(DATA_DIR, store);
const authInfo = auth.initAuth(store);

// Na elk afgerond antwoord: in de wachtrij om de memory bij te werken.
const memoryWorker = startMemoryWorker(store);
onGenerationDone(({ messageId, private: isPrivate }) => {
  // Privé: alleen op verzoek (de knop Onthouden onder een antwoord).
  if (isPrivate || !memoryEnabled(store)) return;
  store.setMemoryStatus(messageId, 'pending');
  memoryWorker.kick();
});

const app = new Hono();

// Privé op slot: netjes melden in plaats van een fout.
app.onError((err, c) => {
  if (err.locked) return lockedResponse(c);
  console.error(`[server] ${c.req.method} ${c.req.path}: ${err.message || err}`);
  return c.json({ error: err.message || 'Er ging iets mis' }, 500);
});

// ---------- Inloggen ----------

// Zonder geldige sessie geen toegang tot de API (de pagina zelf bevat geen gegevens).
// Uitzonderingen: health, inloggen, en de terugkeer na inloggen bij een MCP-server
// (die is beveiligd met een eenmalige code, en komt soms binnen in een ander browservenster).
const OPEN = new Set(['/api/health', '/api/auth', '/api/login', '/api/logout', '/api/mcp/callback']);

// Alles wat iets verandert moet uit de app zelf komen: JSON of een eigen header. Een andere
// website (ook op een andere poort van dezelfde computer) kan dat niet zonder dat de browser
// eerst toestemming vraagt, en die geven we niet.
app.use('/api/*', async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  const type = (c.req.header('content-type') || '').toLowerCase();
  if (type.startsWith('application/json') || c.req.header('x-maatje') === '1') return next();
  return c.json({ error: 'Verzoek geweigerd' }, 403);
});
app.use('/api/*', async (c, next) => {
  if (!auth.authEnabled() || OPEN.has(c.req.path)) return next();
  if (auth.validSession(getCookie(c, auth.COOKIE))) return next();
  return c.json({ error: 'Niet ingelogd', auth: true }, 401);
});

// Het adres van de browser. Achter Tailscale Serve (of een andere proxy) zet de proxy het laatste
// adres in X-Forwarded-For; eerdere adressen kan de browser zelf verzinnen.
function clientIp(c) {
  const fwd = c.req.header('x-forwarded-for');
  const last = fwd ? fwd.split(',').map((x) => x.trim()).filter(Boolean).pop() : '';
  return last || c.env?.incoming?.socket?.remoteAddress || 'onbekend';
}

app.get('/api/auth', (c) =>
  c.json({ enabled: auth.authEnabled(), loggedIn: auth.validSession(getCookie(c, auth.COOKIE)) })
);

app.post('/api/login', async (c) => {
  if (!auth.authEnabled()) return c.json({ ok: true });
  const body = await c.req.json().catch(() => ({}));
  const r = auth.checkPassword(clientIp(c), typeof body.password === 'string' ? body.password : '');
  if (!r.ok) {
    return r.wait
      ? c.json({ error: `Te vaak een verkeerd wachtwoord. Probeer het over ${r.wait} minuten opnieuw.` }, 429)
      : c.json({ error: 'Verkeerd wachtwoord' }, 401);
  }
  const session = auth.makeSession();
  const https = c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
  setCookie(c, auth.COOKIE, session.value, { path: '/', httpOnly: true, sameSite: 'Lax', secure: https, maxAge: session.maxAge });
  return c.json({ ok: true });
});

app.post('/api/logout', (c) => {
  deleteCookie(c, auth.COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ---------- Privé: de kluis ----------

const vaultToken = (c) => getCookie(c, vault.COOKIE);

function lockedResponse(c, extra = {}) {
  const setup = vault.isSetup();
  return c.json({ error: setup ? 'Privé is op slot' : 'Stel eerst een code in voor Privé', locked: true, setup, ...extra }, 423);
}

// Mag deze browser nu in Privé? Telt als activiteit, behalve bij vanzelf verversen op de achtergrond.
const privateOk = (c) => vault.sessionOk(vaultToken(c), { touch: c.req.header('x-maatje-background') !== '1' });

function isHttps(c) {
  return c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}

function setVaultCookie(c, token) {
  // Geen vaste looptijd: de server bepaalt wanneer Privé weer op slot gaat.
  setCookie(c, vault.COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Strict', secure: isHttps(c) });
}

// Alleen JSON, zodat een andere website niet stiekem codes kan proberen vanuit je browser.
async function jsonBody(c) {
  if (!(c.req.header('content-type') || '').toLowerCase().startsWith('application/json')) return null;
  return c.req.json().catch(() => null);
}

// Na openen: wat nog onversleuteld van versie 13 over is, alsnog versleutelen.
async function afterOpen() {
  const release = vault.hold();
  try {
    const r = await mem.migrateLegacyPrivate();
    const chats = store.sealLegacyPrivate();
    if (r.imported || chats) console.log(`[privé] versleuteld: ${r.imported} memory-bestanden, ${chats} chatonderdelen`);
  } catch (err) {
    console.warn(`[privé] overzetten lukte niet helemaal: ${err.message || err}`);
  } finally {
    release();
  }
  memoryWorker.kick();
}

app.get('/api/vault', (c) => c.json(vault.status(vaultToken(c))));

app.post('/api/vault/setup', async (c) => {
  const body = await jsonBody(c);
  if (!body || typeof body.code !== 'string') return c.json({ error: 'Geen code ontvangen' }, 400);
  if (vault.isSetup()) return c.json({ error: 'Er is al een code voor Privé' }, 409);
  try {
    const token = await vault.setup(body.code);
    setVaultCookie(c, token);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
  await afterOpen();
  return c.json({ ...vault.status(null), unlocked: true });
});

app.post('/api/vault/unlock', async (c) => {
  const body = await jsonBody(c);
  if (!body || typeof body.code !== 'string') return c.json({ error: 'Geen code ontvangen' }, 400);
  if (!vault.isSetup()) return lockedResponse(c);
  const r = await vault.unlock(clientIp(c), body.code);
  if (!r.ok) {
    return r.wait
      ? c.json({ error: `Te vaak een verkeerde code. Probeer het over ${r.wait} ${r.wait === 1 ? 'minuut' : 'minuten'} opnieuw.` }, 429)
      : c.json({ error: 'Die code klopt niet' }, 401);
  }
  setVaultCookie(c, r.token);
  await afterOpen();
  return c.json({ ...vault.status(null), unlocked: true });
});

app.post('/api/vault/lock', (c) => {
  vault.lock();
  deleteCookie(c, vault.COOKIE, { path: '/' });
  return c.json(vault.status(null));
});

// Deze browser ging zelf op slot (na niks doen): alleen zijn eigen sessie weg.
app.post('/api/vault/leave', (c) => {
  vault.leave(vaultToken(c));
  deleteCookie(c, vault.COOKIE, { path: '/' });
  return c.json(vault.status(null));
});

// Teken van leven uit de browser zolang je in Privé bezig bent.
app.post('/api/vault/ping', (c) => {
  privateOk(c);
  return c.json(vault.status(vaultToken(c)));
});

app.post('/api/vault/code', async (c) => {
  if (!privateOk(c)) return lockedResponse(c);
  const body = await jsonBody(c);
  if (!body || typeof body.old !== 'string' || typeof body.code !== 'string') return c.json({ error: 'Vul je huidige en je nieuwe code in' }, 400);
  try {
    await vault.changeCode(clientIp(c), body.old, body.code);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
  return c.json({ ok: true });
});

// Code vergeten: Privé helemaal wissen en opnieuw beginnen.
const FORGET_WORD = 'WISSEN';
app.post('/api/vault/forget', async (c) => {
  const body = await jsonBody(c);
  if (!body || String(body.confirm || '').trim().toUpperCase() !== FORGET_WORD) {
    return c.json({ error: `Typ ${FORGET_WORD} om Privé te wissen` }, 400);
  }
  vault.lock();
  store.deleteAllPrivate();
  mem.space('private').destroy();
  vault.forget();
  deleteCookie(c, vault.COOKIE, { path: '/' });
  console.log('[privé] gewist op verzoek (code vergeten)');
  return c.json(vault.status(null));
});

// ---------- Hulpjes ----------

const vendor = {
  'marked.js': fs.readFileSync(path.join(appRoot, 'node_modules/marked/lib/marked.esm.js')),
  'purify.js': fs.readFileSync(path.join(appRoot, 'node_modules/dompurify/dist/purify.es.mjs')),
};

function makeTitle(text) {
  // "/skill-naam ..." aan het begin hoort niet in de titel.
  const line = (text.replace(/^\s*\/[a-z0-9][a-z0-9:_-]*\s*/i, '') || text).replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line || 'Nieuwe chat';
}

const PRIVATE_LOCAL_ONLY = 'In Privé werk je alleen met lokale modellen, zodat je gesprekken thuis blijven. Kies een model onder Lokaal.';

const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];
function cleanEffort(e) {
  return typeof e === 'string' && EFFORTS.includes(e) && e !== 'default' ? e : null;
}

function chatWithState(chat) {
  return { ...chat, generating: isGenerating(chat.id) };
}

// Stuurt de voortgang van een antwoord als regels JSON (NDJSON) naar de browser.
function streamResponse(chatId, first) {
  const enc = new TextEncoder();
  let unsub = null;
  const body = new ReadableStream({
    start(controller) {
      const send = (obj) => {
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch {}
      };
      send(first);
      unsub = subscribe(chatId, (ev) => {
        send(ev);
        if (ev.type === 'done') {
          try { controller.close(); } catch {}
        }
      });
      if (!unsub) {
        send({ type: 'done', message: null });
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      // Browser weg: het antwoord loopt op de server gewoon door.
      if (unsub) unsub();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ---------- API ----------

app.get('/api/health', (c) => c.json({ ok: true, key: hasKey() }));

app.get('/api/models', async (c) => {
  const force = c.req.query('refresh') === '1';
  const [remote, local] = await Promise.all([
    listModels({ force }).then((models) => ({ models, error: null })).catch((err) => ({ models: [], error: err.message })),
    listLocalModels(),
  ]);
  return c.json({ models: remote.models, error: remote.error, local });
});

app.get('/api/settings', (c) =>
  c.json({
    favorites: store.getSetting('favorites', []),
    lastModel: store.getSetting('lastModel', null),
    lastPrivateModel: store.getSetting('lastPrivateModel', null),
    defaultModel: DEFAULT_MODEL || null,
    hasKey: hasKey(),
    keySource: keySource(),
    memoryModel: memoryModel(store),
    memoryEnabled: memoryEnabled(store),
  })
);

app.put('/api/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (Array.isArray(body.favorites)) {
    const favs = [...new Set(body.favorites.filter((f) => typeof f === 'string'))].slice(0, 50);
    store.setSetting('favorites', favs);
  }
  if (typeof body.memoryModel === 'string' && body.memoryModel.trim()) {
    store.setSetting('memoryModel', body.memoryModel.trim());
    memoryWorker.kick();
  }
  if (typeof body.openrouterKey === 'string' && keySource() !== 'env') {
    const key = body.openrouterKey.trim();
    if (key && !/^sk-or-[\w-]{10,}$/.test(key)) return c.json({ error: 'Dat lijkt geen OpenRouter-key (die begint met sk-or-)' }, 400);
    store.setSetting('openrouterKey', key);
    setApiKey(key);
  }
  if (typeof body.memoryEnabled === 'boolean') {
    store.setSetting('memoryEnabled', body.memoryEnabled);
    if (body.memoryEnabled) memoryWorker.kick();
  }
  return c.json({ ok: true });
});

// ---------- Memory ----------
// Twee ruimtes: ?space=work (zakelijk, standaard) of ?space=private (privé).

const spaceParam = (v) => mem.spaceOf(v);

// Privé-memory alleen met een open kluis in deze browser.
app.use('/api/memory/*', async (c, next) => {
  const withBody = ['POST', 'PUT', 'PATCH'].includes(c.req.method);
  const sp = withBody ? (await c.req.json().catch(() => ({}))).space : c.req.query('space');
  const touchesPrivate = c.req.path === '/api/memory/move' || spaceParam(sp) === 'private';
  if (touchesPrivate && !privateOk(c)) return lockedResponse(c);
  return next();
});

app.get('/api/memory', (c) => {
  const sp = spaceParam(c.req.query('space'));
  if (sp === 'private' && !privateOk(c)) return lockedResponse(c);
  const w = writerState;
  // Alleen wat bij deze ruimte hoort: zakelijk ziet niet wanneer of wat er in privé gebeurde.
  const run = w.runs[sp] || {};
  return c.json({
    space: sp,
    files: mem.space(sp).listFiles(),
    writer: {
      model: memoryModel(store),
      enabled: memoryEnabled(store),
      pending: store.countMemoryPending(sp),
      proposals: sp === 'private' ? store.countProposals() : 0,
      running: w.running && w.runningSpace === sp,
      waiting: w.waiting,
      lastRun: run.at || null,
      lastChanged: run.changed || [],
      lastProposed: run.proposed || 0,
      lastSpace: sp,
      lastError: run.error || null,
    },
  });
});

app.get('/api/memory/file', (c) => {
  const p = c.req.query('path');
  if (!mem.validPath(p)) return c.json({ error: 'Ongeldig pad' }, 400);
  const content = mem.space(spaceParam(c.req.query('space'))).readFile(p);
  if (content === null) return c.json({ error: 'Bestand bestaat niet' }, 404);
  return c.json({ path: p, content });
});

app.put('/api/memory/file', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!mem.validPath(body.path)) {
    return c.json({ error: 'Ongeldig pad. Gebruik bijv. /people/naam.md, /areas/project.md of /topics/onderwerp.md (kleine letters, cijfers en streepjes).' }, 400);
  }
  if (typeof body.content !== 'string') return c.json({ error: 'Geen inhoud' }, 400);
  const m = mem.space(spaceParam(body.space));
  const isNew = m.readFile(body.path) === null;
  m.writeFile(body.path, body.content);
  await m.commit(`memory (jij): ${isNew ? 'nieuw' : 'aangepast'} ${body.path}`);
  return c.json({ ok: true });
});

app.delete('/api/memory/file', async (c) => {
  const p = c.req.query('path');
  if (!mem.validPath(p)) return c.json({ error: 'Ongeldig pad' }, 400);
  const m = mem.space(spaceParam(c.req.query('space')));
  m.deleteFile(p);
  await m.commit(`memory (jij): verwijderd ${p}`);
  return c.json({ ok: true });
});

// Een bestand van zakelijk naar privé verplaatsen, of andersom.
app.post('/api/memory/move', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!mem.validPath(body.path)) return c.json({ error: 'Ongeldig pad' }, 400);
  const fromName = spaceParam(body.from);
  const toName = fromName === 'private' ? 'work' : 'private';
  const from = mem.space(fromName);
  const to = mem.space(toName);
  const content = from.readFile(body.path);
  if (content === null) return c.json({ error: 'Bestand bestaat niet' }, 404);
  if (to.readFile(body.path) !== null) {
    return c.json({ error: `Er staat al een bestand ${body.path} in ${toName === 'private' ? 'privé' : 'zakelijk'}. Voeg ze eerst zelf samen.` }, 409);
  }
  to.writeFile(body.path, content);
  from.deleteFile(body.path);
  await to.commit(`memory (jij): verplaatst hierheen ${body.path}`);
  await from.commit(`memory (jij): verplaatst naar ${toName === 'private' ? 'privé' : 'zakelijk'} ${body.path}`);
  // Naar privé: ook de oude versies uit de zakelijke geschiedenis halen, anders zijn ze daar nog te lezen.
  // Lukt dat nu niet, dan blijft het (versleuteld) op de lijst en probeert de app het later opnieuw.
  let purged = true;
  if (toName === 'private') {
    to.addPendingPurge([body.path]);
    purged = await mem.runPendingPurges();
  }
  return c.json({ ok: true, space: toName, purged });
});

app.get('/api/memory/history', async (c) => c.json({ history: await mem.space(spaceParam(c.req.query('space'))).history(20) }));

app.post('/api/memory/run', (c) => {
  memoryWorker.kick();
  return c.json({ ok: true });
});

// Een voorstel voor de privé-memory goedkeuren (helemaal of deels) of afwijzen.
app.post('/api/proposals/:id', async (c) => {
  if (!privateOk(c)) return lockedResponse(c);
  const p = store.getProposal(c.req.param('id'));
  if (!p) return c.json({ error: 'Dit voorstel is al afgehandeld' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const accept = new Set((Array.isArray(body.accept) ? body.accept : []).filter((i) => Number.isInteger(i)));
  const chosen = p.items.filter((_, i) => accept.has(i));
  let changed = [];
  if (chosen.length) changed = (await applyProposal(chosen)).changed;
  store.deleteProposal(p.id);
  store.setMemoryStatus(p.messageId, changed.length ? 'done' : 'none');
  return c.json({ ok: true, changed });
});

// ---------- Skills ----------

app.get('/api/skills', (c) => c.json({ skills: skills.listSkills() }));

app.get('/api/skills/:name', (c) => {
  const s = skills.getSkill(c.req.param('name'));
  return s ? c.json({ skill: s }) : c.json({ error: 'Skill niet gevonden' }, 404);
});

app.put('/api/skills/:name', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    skills.saveSkill(c.req.param('name'), body.content);
    return c.json({ skill: skills.getSkill(c.req.param('name')) });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch('/api/skills/:name', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = c.req.param('name');
  if (!skills.getSkill(name)) return c.json({ error: 'Skill niet gevonden' }, 404);
  if (typeof body.enabled === 'boolean') skills.setEnabled(name, body.enabled);
  return c.json({ skill: skills.getSkill(name) });
});

app.delete('/api/skills/:name', (c) => {
  try {
    skills.deleteSkill(c.req.param('name'));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// Upload van een .zip, .skill of SKILL.md (de inhoud als body, de naam in een header).
app.post('/api/skills/upload', async (c) => {
  const len = Number(c.req.header('content-length') || 0);
  if (len > 60 * 1024 * 1024) return c.json({ error: 'Bestand is te groot (max 60 MB)' }, 413);
  try {
    const buf = await c.req.arrayBuffer();
    const name = decodeURIComponent(c.req.header('x-filename') || '');
    return c.json({ results: skills.importUpload(name, buf) });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// ---------- MCP ----------

// Het adres waarop je de app opent, voor de terugkeer na inloggen.
function originOf(c, body) {
  const o = typeof body?.origin === 'string' ? body.origin.trim().replace(/\/+$/, '') : '';
  return /^https?:\/\/[^/\s]+$/.test(o) ? o : null;
}

app.get('/api/mcp', (c) => c.json({ servers: mcp.listPublic() }));

app.post('/api/mcp/servers', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ server: await mcp.addServer(body, { origin: originOf(c, body) }) });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch('/api/mcp/servers/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ server: await mcp.patchServer(c.req.param('id'), body, { origin: originOf(c, body) }) });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.delete('/api/mcp/servers/:id', async (c) => {
  await mcp.removeServer(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/mcp/servers/:id/connect', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  if (!mcp.publicOne(id)) return c.json({ error: 'MCP-server niet gevonden' }, 404);
  await mcp.connect(id, { origin: originOf(c, body) });
  return c.json({ server: mcp.publicOne(id) });
});

app.post('/api/mcp/servers/:id/logout', async (c) => {
  await mcp.logout(c.req.param('id'));
  return c.json({ server: mcp.publicOne(c.req.param('id')) });
});

// Hier komt de browser terug na het inloggen bij bijv. Supabase.
app.get('/api/mcp/callback', async (c) => {
  const params = new URL(c.req.url).searchParams;
  let title = 'Gekoppeld';
  let text = 'Je kunt dit tabblad sluiten en teruggaan naar Maatje AI.';
  let ok = true;
  try {
    const r = await mcp.finishAuth(params);
    title = `${r.name} is gekoppeld`;
    if (r.status !== 'ok') {
      ok = false;
      title = `${r.name}: ingelogd, maar verbinden lukt nog niet`;
      text = r.error || 'Kijk bij MCP in de zijbalk wat er aan de hand is.';
    }
  } catch (err) {
    ok = false;
    title = 'Koppelen lukte niet';
    text = err.message || String(err);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  return c.html(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Maatje AI</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/fonts/inter/latin-400.css"><link rel="stylesheet" href="/fonts/inter/latin-600.css">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#13151a;font:15px/1.5 Inter,system-ui,-apple-system,sans-serif;padding:24px;box-sizing:border-box}
.card{max-width:420px;background:#fff;border:1px solid #e8ebf0;border-radius:20px;padding:28px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#5b616e;margin:0 0 20px}a{display:inline-block;background:#0181fb;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;font-weight:600}
.dot{width:44px;height:44px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;color:#fff;font-size:22px;background:${ok ? '#0181fb' : '#c62828'}}</style></head>
<body><div class="card"><div class="dot">${ok ? '✓' : '!'}</div><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="/">Terug naar Maatje AI</a></div>
<script>try{window.opener&&window.opener.postMessage({type:'mcp-auth',ok:${ok}},location.origin)}catch(e){}${ok ? 'setTimeout(function(){try{window.close()}catch(e){}},1200)' : ''}</script></body></html>`);
});

// Privéchats alleen in een browser waar Privé open is. Het opvragen van de lijst telt niet als activiteit.
app.get('/api/chats', (c) =>
  c.json({ chats: store.listChats({ includePrivate: vault.sessionOk(vaultToken(c), { touch: false }) }).map(chatWithState) })
);

app.post('/api/chats', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const isPrivate = body.private === true;
  if (isPrivate && !privateOk(c)) return lockedResponse(c);
  const model = typeof body.model === 'string' ? body.model : null;
  const chat = store.createChat({ model: isPrivate && !isLocalModel(model) ? null : model, private: isPrivate });
  return c.json({ chat: chatWithState(chat) });
});

// Voor alles onder /api/chats/:id: privéchat alleen met open kluis.
app.use('/api/chats/:id/*', async (c, next) => {
  if (store.isPrivateChat(c.req.param('id')) && !privateOk(c)) return lockedResponse(c, { private: true });
  return next();
});
app.use('/api/chats/:id', async (c, next) => {
  if (store.isPrivateChat(c.req.param('id')) && !privateOk(c)) return lockedResponse(c, { private: true });
  return next();
});

app.get('/api/chats/:id', (c) => {
  const chat = store.getChat(c.req.param('id'));
  if (!chat) return c.json({ error: 'Chat niet gevonden' }, 404);
  return c.json({
    chat: chatWithState(chat),
    messages: store.listMessages(chat.id),
    ...(chat.private ? { proposals: store.listProposals(chat.id), memoryPending: store.chatMemoryPending(chat.id) } : {}),
  });
});

// Onthouden op verzoek (Privé): de bijwerker kijkt naar het gesprek tot en met dit antwoord en doet een voorstel.
app.post('/api/chats/:id/remember', async (c) => {
  const id = c.req.param('id');
  if (!store.isPrivateChat(id)) return c.json({ error: 'Alleen in Privé' }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (!Number.isInteger(body.messageId) || !store.requestMemory(id, body.messageId)) return c.json({ error: 'Antwoord niet gevonden' }, 404);
  memoryWorker.kick();
  return c.json({ ok: true });
});

// Voorstellen voor de privé-memory in deze chat (de app kijkt hier even na een klik op Onthouden).
app.get('/api/chats/:id/proposals', (c) => {
  const id = c.req.param('id');
  if (!store.isPrivateChat(id)) return c.json({ proposals: [], pending: 0 });
  return c.json({ proposals: store.listProposals(id), pending: store.chatMemoryPending(id) });
});

app.patch('/api/chats/:id', async (c) => {
  const chat = store.getChat(c.req.param('id'));
  if (!chat) return c.json({ error: 'Chat niet gevonden' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.title === 'string' && body.title.trim()) store.renameChat(chat.id, body.title.trim().slice(0, 120));
  if (typeof body.model === 'string' && body.model && (!chat.private || isLocalModel(body.model))) store.setChatModel(chat.id, body.model);
  if (typeof body.effort === 'string') store.setChatEffort(chat.id, cleanEffort(body.effort));
  return c.json({ chat: chatWithState(store.getChat(chat.id)) });
});

app.delete('/api/chats/:id', (c) => {
  const id = c.req.param('id');
  stopGeneration(id);
  store.deleteChat(id);
  return c.json({ ok: true });
});

app.post('/api/chats/:id/messages', async (c) => {
  const chat = store.getChat(c.req.param('id'));
  if (!chat) return c.json({ error: 'Chat niet gevonden' }, 404);
  if (isGenerating(chat.id)) return c.json({ error: 'Er loopt nog een antwoord in deze chat' }, 409);

  const body = await c.req.json().catch(() => ({}));
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!content) return c.json({ error: 'Leeg bericht' }, 400);
  if (!model) return c.json({ error: 'Kies eerst een model' }, 400);
  if (chat.private && !isLocalModel(model)) return c.json({ error: PRIVATE_LOCAL_ONLY }, 400);
  if (!hasKey() && !isLocalModel(model)) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const effort = cleanEffort(body.effort);
  const isFirst = store.countMessages(chat.id) === 0;
  const userId = store.addMessage(chat.id, { role: 'user', content });
  if (isFirst) store.renameChat(chat.id, makeTitle(content));
  store.setChatModel(chat.id, model);
  store.setChatEffort(chat.id, effort);
  store.setSetting(chat.private ? 'lastPrivateModel' : 'lastModel', model);

  const g = startGeneration(store, chat.id, model, { effort });
  return streamResponse(chat.id, {
    type: 'start',
    chat: chatWithState(store.getChat(chat.id)),
    userMessage: store.getMessage(userId),
    assistantId: g.messageId,
  });
});

// Laatste antwoord opnieuw laten maken, eventueel met een ander model.
app.post('/api/chats/:id/regenerate', async (c) => {
  const chat = store.getChat(c.req.param('id'));
  if (!chat) return c.json({ error: 'Chat niet gevonden' }, 404);
  if (isGenerating(chat.id)) return c.json({ error: 'Er loopt nog een antwoord in deze chat' }, 409);

  const body = await c.req.json().catch(() => ({}));
  const model = (typeof body.model === 'string' && body.model.trim()) || chat.model;
  if (!model) return c.json({ error: 'Kies eerst een model' }, 400);
  if (chat.private && !isLocalModel(model)) return c.json({ error: PRIVATE_LOCAL_ONLY }, 400);
  if (!hasKey() && !isLocalModel(model)) return c.json({ error: NO_KEY_MESSAGE }, 400);

  const msgs = store.listMessages(chat.id);
  const last = msgs[msgs.length - 1];
  if (!last) return c.json({ error: 'Niks om opnieuw te doen' }, 400);
  if (last.role === 'assistant') store.deleteMessage(chat.id, last.id);

  const effort = typeof body.effort === 'string' ? cleanEffort(body.effort) : chat.effort;
  store.setChatModel(chat.id, model);
  store.setChatEffort(chat.id, effort);
  store.setSetting(chat.private ? 'lastPrivateModel' : 'lastModel', model);
  const g = startGeneration(store, chat.id, model, { effort });
  return streamResponse(chat.id, {
    type: 'start',
    chat: chatWithState(store.getChat(chat.id)),
    replacedId: last.role === 'assistant' ? last.id : null,
    assistantId: g.messageId,
  });
});

// Meekijken met een antwoord dat al loopt (bijv. na herladen).
app.get('/api/chats/:id/stream', (c) => {
  const id = c.req.param('id');
  const live = liveState(id);
  if (!live) return c.json({ generating: false });
  return streamResponse(id, { type: 'resume', ...live });
});

app.post('/api/chats/:id/stop', (c) => c.json({ stopped: stopGeneration(c.req.param('id')) }));

// Toestemming geven of weigeren voor een tool die iets wil wijzigen.
app.post('/api/chats/:id/approval', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const decision = ['allow', 'always', 'deny'].includes(body.decision) ? body.decision : null;
  if (!decision || typeof body.id !== 'string') return c.json({ error: 'Ongeldig antwoord' }, 400);
  const ok = answerApproval(c.req.param('id'), body.id, decision);
  return ok ? c.json({ ok: true }) : c.json({ error: 'Deze vraag is al beantwoord of verlopen' }, 409);
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Niet gevonden' }, 404) : c.text('Niet gevonden', 404)));

// ---------- Pagina ----------

app.get('/vendor/:file', (c) => {
  const file = vendor[c.req.param('file')];
  if (!file) return c.notFound();
  return c.body(file, 200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  });
});

// Lettertypes (Poppins en Fraunces) staan in het pakket zelf, dus geen Google Fonts nodig.
app.use(
  '/fonts/*',
  serveStatic({
    root: './node_modules/@fontsource',
    rewriteRequestPath: (p) => p.replace(/^\/fonts/, ''),
    onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=604800'),
  })
);

app.use('/*', serveStatic({ root: './public' }));

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Maatje AI draait op http://${HOST}:${info.port}`);
  console.log(`Data in ${DATA_DIR}`);
  if (!authInfo.enabled) console.log('Inloggen staat uit (AUTH=off). Zorg dat de app niet vanaf internet bereikbaar is.');
  else if (authInfo.generated) console.log(`Wachtwoord voor Maatje AI: ${authInfo.generated}   (kies je eigen met APP_PASSWORD in .env)`);
  else console.log('Inloggen met het wachtwoord uit APP_PASSWORD.');
  if (!hasKey()) console.log('Nog geen OpenRouter-key: vul hem in bij de modelkiezer in de app, of zet OPENROUTER_API_KEY in .env.');
});
