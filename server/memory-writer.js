// Werkt na elk gesprek de memory bij, op de achtergrond.
// Elk afgerond antwoord komt in een wachtrij. Staat het bijwerk-model op je Mac
// en is die even niet bereikbaar, dan blijft het in de wachtrij staan tot hij terug is.
//
// Privé werkt anders: daar schrijft de bijwerker niks zelf. Hij maakt een voorstel, en jij
// kiest in de chat wat er in je privé-memory mag. Dat gebeurt altijd met een lokaal model,
// en alleen als Privé open is.
import * as mem from './memory.js';
import * as vault from './vault.js';
import { completeJSON, listLocalModels, isLocalModel } from './openrouter.js';

// Standaard: MEMORY_MODEL uit .env. Anders het model waarmee je het laatst chatte (in de app te wijzigen).
export const DEFAULT_MEMORY_MODEL = (process.env.MEMORY_MODEL || '').trim();

export const writerState = {
  running: false,
  lastRun: null,
  lastChanged: [],
  lastError: null,
  waiting: null, // bijv. 'mac' als we wachten tot je Mac terug is
  lastProposed: 0, // aantal voorgestelde wijzigingen bij de laatste privéklus
  runningSpace: null,
  runs: { work: {}, private: {} }, // per ruimte: { at, changed, proposed, error }
};

export const memoryModel = (store) => store.getSetting('memoryModel', null) || DEFAULT_MEMORY_MODEL || store.getSetting('lastModel', null) || '';
export const memoryEnabled = (store) => store.getSetting('memoryEnabled', true) !== false;

// ---------- Wat er nooit in mag ----------

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // API-keys (OpenRouter, OpenAI, Anthropic)
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, // tokens (JWT)
  /\b[A-Z]{2}\d{2}\s?[A-Z]{4}\s?(?:\d{4}\s?){2}\d{2,4}\b/, // IBAN
  /(?:\d[ -]?){13,19}/, // pasnummers
  /\b(?:wachtwoord|password|passwd|pincode|pin-code|toegangscode)\b\s*(?:is|:|=)/i,
  /\b(?:bsn|burgerservicenummer|paspoortnummer|rijbewijsnummer|id-nummer)\b[^\n]{0,25}\d{6,}/i,
];

export const containsSecret = (text) => SECRET_PATTERNS.some((re) => re.test(String(text || '')));

// ---------- De opdracht voor het model ----------

const SYSTEM = `You maintain a long-term memory for one user as markdown files. After each chat turn you decide whether anything durable should be saved. Most turns need no change at all.

FILES
- /profile.md: who the user is (stable identity: role, company, location, age).
- /preferences.md: how the assistant must behave (format, tone, things to avoid). Only instructions about the assistant's answers.
- /people/<slug>.md: one file per person, client or company.
- /areas/<slug>.md: one file per ongoing project, responsibility or recurring piece of work.
- /topics/<slug>.md: other facts about the user, per domain (habits, tools, routines, tastes).
Slugs are lowercase: a-z, 0-9 and dashes.

WHAT TO SAVE
- Only what the USER said in the latest user message. Never save the assistant's suggestions, research, drafts, advice or conclusions, unless the user clearly confirmed or adopted them in that message (e.g. "ja, doen we", "goed, zo gaan we het doen").
- Save durable things: people and their role, clients, projects, decisions, deadlines, plans, preferences about the assistant, stable facts about the user. Also save anything the user explicitly asks to remember ("onthoud ...").
- Do not save small talk, one-off questions, temporary moods, or things the files already say.
- If the user says something is no longer true, use "replace" on the old line. If the user asks to forget something, use "remove".
- Never save passwords, API keys, tokens, bank/IBAN/card numbers, BSN or other ID numbers.
- Write each fact as one short line starting with "- ", in Dutch, close to the user's own words. Add month and year when timing matters, e.g. "(okt 2026)".
- Put a fact in the file of the subject it is about. Check the aliases in the listing to find the right file; prefer an existing file. Create a new file only if nothing fits.

OUTPUT
Return only JSON: {"ops": [...]}. Possible ops:
{"op":"append","path":"/people/x.md","line":"- ..."}
{"op":"create","path":"/people/x.md","description":"one line: what this file covers","aliases":["Name","Other name"],"lines":["- ...","- ..."]}
{"op":"replace","path":"/people/x.md","old":"<exact existing line>","new":"- ..."}
{"op":"remove","path":"/people/x.md","old":"<exact existing line>"}
If nothing should change, return {"ops": []}.`;

const SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['append', 'create', 'replace', 'remove'] },
          path: { type: 'string' },
          line: { type: 'string' },
          description: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          lines: { type: 'array', items: { type: 'string' } },
          old: { type: 'string' },
          new: { type: 'string' },
        },
        required: ['op', 'path'],
      },
    },
  },
  required: ['ops'],
};

const clip = (s, n) => {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const PREF_HINT = /\b(voortaan|altijd|nooit|liever|graag|niet meer|stop met|onthoud|vergeet|schrijf|gebruik)\b/i;

function buildPrompt(store, job, m) {
  const before = store.messagesBefore(job.chat_id, job.id, 5);
  const userMsg = before.find((m) => m.role === 'user');
  if (!userMsg) return null;
  const earlier = before.filter((m) => m.id < userMsg.id).reverse().slice(-2);

  const files = m.listFiles();
  const listing = files
    .map((f) => `${f.path}${f.aliases.length ? ` [${f.aliases.slice(0, 8).join(', ')}]` : ''}`)
    .join('\n');

  const relevantText = `${userMsg.content}\n${job.content}`;
  const relevant = m.matchFiles(relevantText, { files, limit: 4 });
  const full = [];
  const profile = m.readFile('/profile.md');
  if (profile) full.push(`=== /profile.md ===\n${clip(profile, 4000)}`);
  if (PREF_HINT.test(userMsg.content)) {
    const prefs = m.readFile('/preferences.md');
    if (prefs) full.push(`=== /preferences.md ===\n${clip(prefs, 12000)}`);
  }
  for (const f of relevant) full.push(`=== ${f.path} ===\n${clip(m.readFile(f.path) || '', 6000)}`);

  const today = new Intl.DateTimeFormat('nl-NL', { timeZone: process.env.TZ || 'Europe/Amsterdam', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

  const parts = [
    `Today: ${today}.`,
    `FILE LISTING (path [aliases]):\n${listing || '(no files yet)'}`,
    `RELEVANT FILES (full content):\n${full.join('\n\n') || '(none)'}`,
  ];
  if (earlier.length) {
    parts.push(
      `EARLIER IN THIS CHAT (context only, do not save from here):\n` +
        earlier.map((m) => `${m.role.toUpperCase()}: ${clip(m.content, 1200)}`).join('\n')
    );
  }
  parts.push(`LATEST TURN:\nUSER: ${clip(userMsg.content, 4000)}\nASSISTANT: ${clip(job.content, 2500)}`);
  parts.push('Return the JSON now.');
  return parts.join('\n\n');
}

// ---------- Wijzigingen toepassen ----------

const norm = (s) =>
  String(s || '')
    .replace(/^\s*-\s*/, '')
    .replace(/^\[(?:stated|observed|inferred)\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function normalizePath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim().toLowerCase().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  if (!s.endsWith('.md')) s += '.md';
  s = s.replace(/[\s_]+/g, '-').replace(/[^a-z0-9/.-]/g, '').replace(/-+/g, '-');
  return mem.validPath(s) ? s : null;
}

function normalizeLine(line) {
  let s = String(line || '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!s) return null;
  if (!s.startsWith('- ')) s = '- ' + s.replace(/^-\s*/, '');
  return s.length > 600 ? s.slice(0, 599) + '…' : s;
}

function splitFile(content) {
  const m = String(content).match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  return m ? { head: m[1].endsWith('\n') ? m[1] : m[1] + '\n', body: m[2] } : { head: '', body: String(content) };
}

export function applyOps(ops, m = mem.space('work')) {
  const changed = new Set();
  const skipped = [];
  for (const raw of (Array.isArray(ops) ? ops : []).slice(0, 8)) {
    const path = normalizePath(raw?.path);
    if (!path) { skipped.push('ongeldig pad'); continue; }
    const texts = [raw.line, raw.new, raw.description, ...(raw.lines || []), ...(raw.aliases || [])];
    if (texts.some(containsSecret)) { skipped.push(`${path}: bevat iets wat op een key of nummer lijkt`); continue; }

    const existing = m.readFile(path);
    const slug = path.split('/').pop().replace(/\.md$/, '');

    if (raw.op === 'append' || raw.op === 'create') {
      const lines = (raw.op === 'append' ? [raw.line] : raw.lines || []).map(normalizeLine).filter(Boolean);
      if (!lines.length) continue;
      if (existing === null) {
        const description = clip(String(raw.description || '').replace(/\n/g, ' ').trim(), 200);
        const aliases = (raw.aliases || []).map((a) => clip(String(a).trim(), 60)).filter(Boolean).slice(0, 8);
        m.writeFile(path, mem.makeFile({ name: slug, description, aliases, lines }));
        changed.add(path);
      } else {
        const have = new Set(existing.split('\n').map(norm));
        const fresh = lines.filter((l) => !have.has(norm(l)));
        if (!fresh.length) continue;
        const sep = existing.endsWith('\n') ? '' : '\n';
        m.writeFile(path, existing + sep + fresh.join('\n') + '\n');
        changed.add(path);
      }
    } else if (raw.op === 'replace' || raw.op === 'remove') {
      if (existing === null) continue;
      const { head, body } = splitFile(existing);
      const lines = body.split('\n');
      const target = norm(raw.old);
      if (!target) continue;
      let idx = lines.findIndex((l) => norm(l) === target);
      if (idx < 0) idx = lines.findIndex((l) => l.trim().startsWith('-') && norm(l).includes(target));
      if (raw.op === 'replace') {
        const next = normalizeLine(raw.new);
        if (!next) continue;
        if (idx >= 0) lines[idx] = next;
        else lines.push(next);
      } else {
        if (idx < 0) continue;
        lines.splice(idx, 1);
      }
      m.writeFile(path, head + lines.join('\n').replace(/\n*$/, '\n'));
      changed.add(path);
    }
  }
  return { changed: [...changed], skipped };
}

// ---------- Voorstellen (privé) ----------

const cleanList = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => clip(String(x ?? '').replace(/\n/g, ' ').trim(), len)).filter(Boolean).slice(0, n);

// Een wijziging in een vaste, nette vorm, zodat je ziet wat er precies gebeurt als je hem goedkeurt.
function cleanOp(raw) {
  const path = normalizePath(raw?.path);
  if (!path || !['append', 'create', 'replace', 'remove'].includes(raw?.op)) return null;
  const op = { op: raw.op, path };
  if (raw.op === 'append') op.line = normalizeLine(raw.line);
  if (raw.op === 'create') {
    op.lines = cleanList(raw.lines, 30, 600).map(normalizeLine).filter(Boolean);
    op.description = clip(String(raw.description || '').replace(/\n/g, ' ').trim(), 200);
    op.aliases = cleanList(raw.aliases, 8, 60);
  }
  if (raw.op === 'replace' || raw.op === 'remove') op.old = clip(String(raw.old || '').replace(/\n/g, ' ').trim(), 600);
  if (raw.op === 'replace') op.new = normalizeLine(raw.new);
  return op;
}

// Probeert de wijzigingen uit zonder iets op te slaan, en houdt alleen de wijzigingen over die echt iets doen.
export function effectiveOps(ops, m) {
  const overlay = new Map();
  const view = {
    readFile: (p) => (overlay.has(p) ? overlay.get(p) : m.readFile(p)),
    writeFile: (p, c) => overlay.set(p, String(c)),
  };
  const kept = [];
  for (const raw of (Array.isArray(ops) ? ops : []).slice(0, 8)) {
    const op = cleanOp(raw);
    if (!op) continue;
    const r = applyOps([op], view);
    if (r.changed.length) {
      // Voor de weergave: is het bestand nieuw?
      kept.push({ ...op, isNew: m.readFile(op.path) === null });
    }
  }
  return kept;
}

// Past goedgekeurde wijzigingen uit een voorstel toe op de privé-memory.
export async function applyProposal(items) {
  const m = mem.space('private');
  const ops = items.map(cleanOp).filter(Boolean);
  const outcome = applyOps(ops, m);
  if (outcome.changed.length) await m.commit(`memory (jij, voorstel): ${outcome.changed.join(', ')}`);
  return outcome;
}

// ---------- De wachtrij ----------

// Model voor privé: altijd lokaal. Het ingestelde bijwerk-model als dat lokaal is, anders het model van de chat.
function privateModel(store, chat) {
  const mm = memoryModel(store);
  if (isLocalModel(mm)) return mm;
  if (isLocalModel(chat?.model)) return chat.model;
  return null;
}

async function processJob(store, job, model) {
  // Een privéchat werkt alleen de privé-memory bij, een gewone chat alleen de zakelijke.
  const spaceName = job.private ? 'private' : 'work';
  const m = mem.space(spaceName);
  if (spaceName === 'private') {
    const release = vault.hold();
    try {
      const prompt = buildPrompt(store, job, m);
      if (!prompt) return { changed: [], proposed: 0, space: spaceName };
      // Korter dan normaal: zolang dit loopt blijft de sleutel van Privé in het geheugen.
      const result = await completeJSON({ model, system: SYSTEM, user: prompt, schema: SCHEMA, timeoutMs: 5 * 60 * 1000 });
      const items = effectiveOps(result?.ops, m);
      if (items.length) store.addProposal(job.chat_id, job.id, items);
      return { changed: [], proposed: items.length, space: spaceName };
    } finally {
      release();
    }
  }
  const prompt = buildPrompt(store, job, m);
  if (!prompt) return { changed: [], skipped: [], space: spaceName };
  const result = await completeJSON({ model, system: SYSTEM, user: prompt, schema: SCHEMA });
  const outcome = applyOps(result?.ops, m);
  outcome.space = spaceName;
  if (outcome.changed.length) {
    await m.commit(`memory (bijwerker): ${outcome.changed.join(', ')}`);
  }
  if (outcome.skipped.length) console.warn('[memory] overgeslagen:', outcome.skipped.join('; '));
  return outcome;
}

export function startMemoryWorker(store) {
  const tick = async () => {
    if (writerState.running) return;
    writerState.running = true;
    try {
      let skipPrivate = false; // privé wacht op je Mac, zakelijk kan misschien wel door
      while (memoryEnabled(store)) {
        // Privé alleen zolang er echt iemand in Privé bezig is, anders houdt de bijwerker de sleutel vast.
        const job = store.nextMemoryJob({ includePrivate: vault.isOpen() && vault.activeSessions() > 0 && !skipPrivate });
        if (!job) { if (!skipPrivate) writerState.waiting = null; break; }
        const chat = job.private ? store.getChat(job.chat_id) : null;
        const model = job.private ? privateModel(store, chat) : memoryModel(store);
        if (!model) {
          // Een privéchat zonder lokaal model (van voor versie 14) slaan we over.
          if (job.private) { store.setMemoryStatus(job.id, 'none'); continue; }
          writerState.waiting = 'model';
          break;
        }

        if (isLocalModel(model)) {
          const local = await listLocalModels();
          if (local.status !== 'ok') {
            writerState.waiting = 'mac';
            if (job.private) { skipPrivate = true; continue; }
            break;
          }
        }
        if (!skipPrivate) writerState.waiting = null;

        const space = job.private ? 'private' : 'work';
        writerState.runningSpace = space;
        try {
          const outcome = await processJob(store, job, model);
          store.setMemoryStatus(job.id, outcome.proposed ? 'proposed' : outcome.changed.length ? 'done' : 'none');
          writerState.lastRun = Date.now();
          writerState.lastChanged = outcome.changed;
          writerState.lastProposed = outcome.proposed || 0;
          writerState.lastSpace = outcome.space;
          writerState.lastError = null;
          writerState.runs[space] = { at: Date.now(), changed: outcome.changed, proposed: outcome.proposed || 0, error: null };
        } catch (err) {
          if (err.locked) { skipPrivate = true; continue; } // Privé ging net op slot; later verder
          writerState.lastError = err.message || String(err);
          writerState.runs[space] = { ...writerState.runs[space], error: writerState.lastError };
          console.warn(`[memory] ${space === 'private' ? 'privé: ' : ''}${writerState.lastError}`);
          if (err.offline) {
            writerState.waiting = 'mac';
            if (job.private) { skipPrivate = true; continue; }
            break;
          }
          if (store.bumpMemoryAttempts(job.id) >= 3) store.setMemoryStatus(job.id, 'error');
          break; // volgende poging bij de volgende ronde
        }
      }
    } finally {
      writerState.running = false;
      writerState.runningSpace = null;
    }
  };

  const interval = setInterval(tick, 60 * 1000);
  interval.unref?.();
  setTimeout(tick, 5000);
  return { kick: () => setTimeout(tick, 1000) };
}
