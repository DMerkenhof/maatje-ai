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
import { listModels, listLocalModels, hasKey, isLocalModel } from './openrouter.js';
import { startGeneration, stopGeneration, subscribe, isGenerating, liveState, onGenerationDone, answerApproval } from './generate.js';
import { startMemoryWorker, writerState, memoryModel, memoryEnabled } from './memory-writer.js';
import * as mcp from './mcp.js';
import * as skills from './skills.js';
import * as auth from './auth.js';

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
mem.ensureMemoryDirs(DATA_DIR);
mcp.initMcp(store);
skills.initSkills(DATA_DIR, store);
const authInfo = auth.initAuth(store);

// Na elk afgerond antwoord: in de wachtrij om de memory bij te werken.
const memoryWorker = startMemoryWorker(store);
onGenerationDone(({ messageId }) => {
  if (!memoryEnabled(store)) return;
  store.setMemoryStatus(messageId, 'pending');
  memoryWorker.kick();
});

const app = new Hono();

// ---------- Inloggen ----------

// Zonder geldige sessie geen toegang tot de API (de pagina zelf bevat geen gegevens).
// Uitzonderingen: health, inloggen, en de terugkeer na inloggen bij een MCP-server
// (die is beveiligd met een eenmalige code, en komt soms binnen in een ander browservenster).
const OPEN = new Set(['/api/health', '/api/auth', '/api/login', '/api/logout', '/api/mcp/callback']);
app.use('/api/*', async (c, next) => {
  if (!auth.authEnabled() || OPEN.has(c.req.path)) return next();
  if (auth.validSession(getCookie(c, auth.COOKIE))) return next();
  return c.json({ error: 'Niet ingelogd', auth: true }, 401);
});

function clientIp(c) {
  const fwd = c.req.header('x-forwarded-for');
  return (fwd && fwd.split(',')[0].trim()) || c.env?.incoming?.socket?.remoteAddress || 'onbekend';
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
    defaultModel: DEFAULT_MODEL || null,
    hasKey: hasKey(),
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
  if (typeof body.memoryEnabled === 'boolean') {
    store.setSetting('memoryEnabled', body.memoryEnabled);
    if (body.memoryEnabled) memoryWorker.kick();
  }
  return c.json({ ok: true });
});

// ---------- Memory ----------

app.get('/api/memory', (c) =>
  c.json({
    files: mem.listFiles(),
    writer: {
      model: memoryModel(store),
      enabled: memoryEnabled(store),
      pending: store.countMemoryPending(),
      running: writerState.running,
      waiting: writerState.waiting,
      lastRun: writerState.lastRun,
      lastChanged: writerState.lastChanged,
      lastError: writerState.lastError,
    },
  })
);

app.get('/api/memory/file', (c) => {
  const p = c.req.query('path');
  if (!mem.validPath(p)) return c.json({ error: 'Ongeldig pad' }, 400);
  const content = mem.readFile(p);
  if (content === null) return c.json({ error: 'Bestand bestaat niet' }, 404);
  return c.json({ path: p, content });
});

app.put('/api/memory/file', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!mem.validPath(body.path)) {
    return c.json({ error: 'Ongeldig pad. Gebruik bijv. /people/naam.md, /areas/project.md of /topics/onderwerp.md (kleine letters, cijfers en streepjes).' }, 400);
  }
  if (typeof body.content !== 'string') return c.json({ error: 'Geen inhoud' }, 400);
  const isNew = mem.readFile(body.path) === null;
  mem.writeFile(body.path, body.content);
  await mem.commit(`memory (jij): ${isNew ? 'nieuw' : 'aangepast'} ${body.path}`);
  return c.json({ ok: true });
});

app.delete('/api/memory/file', async (c) => {
  const p = c.req.query('path');
  if (!mem.validPath(p)) return c.json({ error: 'Ongeldig pad' }, 400);
  mem.deleteFile(p);
  await mem.commit(`memory (jij): verwijderd ${p}`);
  return c.json({ ok: true });
});

app.get('/api/memory/history', async (c) => c.json({ history: await mem.history(20) }));

app.post('/api/memory/run', (c) => {
  memoryWorker.kick();
  return c.json({ ok: true });
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

app.get('/api/chats', (c) => c.json({ chats: store.listChats().map(chatWithState) }));

app.post('/api/chats', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const chat = store.createChat({ model: typeof body.model === 'string' ? body.model : null });
  return c.json({ chat: chatWithState(chat) });
});

app.get('/api/chats/:id', (c) => {
  const chat = store.getChat(c.req.param('id'));
  if (!chat) return c.json({ error: 'Chat niet gevonden' }, 404);
  return c.json({ chat: chatWithState(chat), messages: store.listMessages(chat.id) });
});

app.patch('/api/chats/:id', async (c) => {
  const chat = store.getChat(c.req.param('id'));
  if (!chat) return c.json({ error: 'Chat niet gevonden' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.title === 'string' && body.title.trim()) store.renameChat(chat.id, body.title.trim().slice(0, 120));
  if (typeof body.model === 'string' && body.model) store.setChatModel(chat.id, body.model);
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
  if (!hasKey() && !isLocalModel(model)) return c.json({ error: 'Er staat nog geen OpenRouter-key in .env' }, 400);

  const effort = cleanEffort(body.effort);
  const isFirst = store.countMessages(chat.id) === 0;
  const userId = store.addMessage(chat.id, { role: 'user', content });
  if (isFirst) store.renameChat(chat.id, makeTitle(content));
  store.setChatModel(chat.id, model);
  store.setChatEffort(chat.id, effort);
  store.setSetting('lastModel', model);

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
  if (!hasKey() && !isLocalModel(model)) return c.json({ error: 'Er staat nog geen OpenRouter-key in .env' }, 400);

  const msgs = store.listMessages(chat.id);
  const last = msgs[msgs.length - 1];
  if (!last) return c.json({ error: 'Niks om opnieuw te doen' }, 400);
  if (last.role === 'assistant') store.deleteMessage(chat.id, last.id);

  const effort = typeof body.effort === 'string' ? cleanEffort(body.effort) : chat.effort;
  store.setChatModel(chat.id, model);
  store.setChatEffort(chat.id, effort);
  store.setSetting('lastModel', model);
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
  if (!hasKey()) console.warn('Let op: OPENROUTER_API_KEY is leeg');
});
