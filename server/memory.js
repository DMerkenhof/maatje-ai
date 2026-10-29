// Het geheugen: gewone markdown-bestanden in /data/memory.
//
//   profile.md       wie je bent
//   preferences.md   hoe het model zich moet gedragen
//   people/          één bestand per persoon of bedrijf
//   areas/           één bestand per project of lopende klus
//   topics/          de rest, per onderwerp
//
// Elke wijziging wordt vastgelegd in git, zodat je kunt zien wat er wanneer veranderde.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

let ROOT = null;
const SUBDIRS = ['people', 'areas', 'topics'];
const PATH_RE = /^\/(?:(?:profile|preferences)|(?:people|areas|topics)\/[a-z0-9][a-z0-9-]{0,80})\.md$/;

export const validPath = (p) => typeof p === 'string' && PATH_RE.test(p);
const abs = (p) => path.join(ROOT, p);

// ---------- Opzet en git ----------

export function ensureMemoryDirs(dataDir) {
  ROOT = path.join(dataDir, 'memory');
  for (const sub of SUBDIRS) fs.mkdirSync(path.join(ROOT, sub), { recursive: true });
  initGit();
  return ROOT;
}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

let gitReady = false;
async function initGit() {
  const check = await git(['--version']);
  if (!check.ok) {
    console.warn('[memory] git niet gevonden, wijzigingen worden niet bijgehouden');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    await git(['init', '-q']);
  }
  await git(['config', 'user.name', 'Maatje AI']);
  await git(['config', 'user.email', 'chat@localhost']);
  gitReady = true;
  await commit('memory: begintoestand');
}

// Wijzigingen na elkaar vastleggen, nooit door elkaar heen.
let commitQueue = Promise.resolve();
export function commit(message) {
  commitQueue = commitQueue.then(async () => {
    if (!gitReady) return;
    await git(['add', '-A']);
    const status = await git(['status', '--porcelain']);
    if (!status.out.trim()) return;
    await git(['commit', '-q', '-m', message]);
  });
  return commitQueue;
}

export async function history(limit = 15) {
  if (!gitReady) return [];
  const r = await git(['log', `-n${limit}`, '--date=iso-strict', '--name-status', '--pretty=format:@@%H|%ad|%s']);
  if (!r.ok) return [];
  const entries = [];
  for (const block of r.out.split('@@').filter(Boolean)) {
    const [head, ...lines] = block.trim().split('\n');
    const [hash, date, ...msg] = head.split('|');
    const files = lines
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2)
      .map(([status, file]) => ({ status, path: '/' + file }));
    entries.push({ hash: hash.slice(0, 8), date, message: msg.join('|'), files });
  }
  return entries;
}

export async function fileHistory(p, limit = 10) {
  if (!gitReady || !validPath(p)) return [];
  const r = await git(['log', `-n${limit}`, '--date=iso-strict', '-p', '--pretty=format:@@%h|%ad|%s', '--', p.slice(1)]);
  return r.ok ? r.out : '';
}

// ---------- Bestanden ----------

export function readFile(p) {
  if (!validPath(p)) return null;
  try { return fs.readFileSync(abs(p), 'utf8'); } catch { return null; }
}

export function writeFile(p, content) {
  if (!validPath(p)) throw new Error('Ongeldig pad');
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  let text = String(content).replace(/\r\n/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(abs(p), text, 'utf8');
}

export function deleteFile(p) {
  if (!validPath(p)) throw new Error('Ongeldig pad');
  fs.rmSync(abs(p), { force: true });
}

export function parseFile(content) {
  const out = { name: '', description: '', aliases: [], body: content || '' };
  if (!content) return out;
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return out;
  out.body = m[2];
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'name') out.name = value.trim();
    else if (key === 'description') out.description = value.trim();
    else if (key === 'aliases') out.aliases = parseList(value);
  }
  return out;
}

function parseList(value) {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

export function makeFile({ name, description = '', aliases = [], lines = [] }) {
  const al = aliases.map((a) => (/[,\[\]"]/.test(a) ? JSON.stringify(a) : a)).join(', ');
  return `---\nname: ${name}\ndescription: ${description}\naliases: [${al}]\n---\n${lines.join('\n')}\n`;
}

export function listFiles() {
  if (!ROOT) return [];
  const files = [];
  const add = (rel) => {
    const full = abs(rel);
    let stat;
    try { stat = fs.statSync(full); } catch { return; }
    const content = fs.readFileSync(full, 'utf8');
    const meta = parseFile(content);
    files.push({
      path: rel,
      name: meta.name || path.basename(rel, '.md'),
      description: meta.description,
      aliases: meta.aliases,
      size: stat.size,
      updated: stat.mtimeMs,
    });
  };
  for (const top of ['/profile.md', '/preferences.md']) if (fs.existsSync(abs(top))) add(top);
  for (const sub of SUBDIRS) {
    let names = [];
    try { names = fs.readdirSync(path.join(ROOT, sub)); } catch {}
    for (const n of names.sort()) {
      if (n.endsWith('.md') && validPath(`/${sub}/${n}`)) add(`/${sub}/${n}`);
    }
  }
  return files;
}

// ---------- Welke bestanden horen bij een tekst ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Zoekt bestanden waarvan de naam of een alias in de tekst voorkomt.
export function matchFiles(text, { limit = 4, files = listFiles() } = {}) {
  const hay = ` ${String(text || '').toLowerCase()} `;
  if (!hay.trim()) return [];
  const scored = [];
  for (const f of files) {
    if (f.path === '/profile.md' || f.path === '/preferences.md') continue;
    const terms = new Set([...f.aliases, f.name.replace(/-/g, ' ')].map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3));
    let score = 0;
    for (const t of terms) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'u');
      if (re.test(hay)) score += t.length >= 6 ? 3 : 1;
    }
    if (score) scored.push({ f, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.f.updated - a.f.updated)
    .slice(0, limit)
    .map((s) => s.f);
}

// ---------- Context voor het chatmodel ----------

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function memoryReadTool() {
  return {
    type: 'function',
    function: {
      name: 'memory_read',
      description: 'Lees een of meer bestanden uit het geheugen van de gebruiker. Gebruik de paden uit de lijst met bestanden.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Paden, bijv. ["/people/tripleclub.md"]' },
        },
        required: ['paths'],
      },
    },
  };
}

export function runMemoryRead(args) {
  const paths = Array.isArray(args?.paths) ? args.paths : typeof args?.path === 'string' ? [args.path] : [];
  const out = [];
  const read = [];
  for (const p of paths.slice(0, 8)) {
    const content = readFile(p);
    if (content === null) out.push(`=== ${p} ===\n(bestaat niet)`);
    else {
      out.push(`=== ${p} ===\n${clip(content, 12000)}`);
      read.push(p);
    }
  }
  return { text: out.join('\n\n') || '(geen paden opgegeven)', read };
}

// Bouwt het geheugendeel van de systeemprompt. Geeft ook terug welke bestanden erin staan.
export function buildMemoryContext({ recentText = '', withTool = false, compact = false } = {}) {
  if (!ROOT) return { text: '', files: [] };
  const files = listFiles();
  if (!files.length) return { text: '', files: [] };

  const profile = parseFile(readFile('/profile.md') || '').body.trim();
  const prefs = parseFile(readFile('/preferences.md') || '').body.trim();
  const used = [];
  if (profile) used.push('/profile.md');
  if (prefs) used.push('/preferences.md');

  const listing = files
    .filter((f) => f.path !== '/profile.md' && f.path !== '/preferences.md')
    .map((f) => {
      const desc = clip(f.description || '', compact ? 90 : 160);
      const al = !compact && f.aliases.length ? ` [${f.aliases.slice(0, 6).join(', ')}]` : '';
      return `- ${f.path}: ${desc}${al}`;
    })
    .join('\n');

  const matched = matchFiles(recentText, { files, limit: compact ? 3 : 4 });
  let budget = compact ? 9000 : 16000;
  const included = [];
  for (const f of matched) {
    if (budget <= 500) break;
    const body = parseFile(readFile(f.path) || '').body.trim();
    const piece = clip(body, Math.min(budget, compact ? 4000 : 7000));
    budget -= piece.length;
    included.push(`#### ${f.path}\n${piece}`);
    used.push(f.path);
  }

  const parts = [
    '## Geheugen',
    'Hieronder staat wat je weet over de gebruiker, uit eerdere gesprekken. Gebruik het alleen als het je antwoord echt beter maakt, en verwerk het natuurlijk: zeg niet "volgens mijn geheugen" of "ik zie in je bestanden". Begin niet ongevraagd over gevoelige of vervelende dingen; wacht tot de gebruiker er zelf over begint.',
  ];
  if (profile) parts.push(`### Profiel\n${profile}`);
  if (prefs) parts.push(`### Voorkeuren van de gebruiker (volg deze altijd)\n${prefs}`);
  parts.push(
    `### Bestanden in het geheugen\n` +
      (withTool
        ? 'Lijkt een bestand relevant voor de vraag, open het dan met de tool memory_read voordat je antwoordt. Zeg nooit dat je iets niet weet zonder eerst het passende bestand te lezen.\n'
        : 'Bestanden die bij dit gesprek lijken te horen, staan hieronder al uitgeschreven. Van de andere zie je alleen de omschrijving.\n') +
      listing
  );
  if (included.length) parts.push(`### Uitgeschreven bestanden\n${included.join('\n\n')}`);

  return { text: parts.join('\n\n'), files: used };
}

export function buildSystemPrompt(opts = {}) {
  const today = new Intl.DateTimeFormat('nl-NL', {
    timeZone: process.env.TZ || 'Europe/Amsterdam',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());

  const parts = [`Vandaag is het ${today}.`];
  if (process.env.SYSTEM_PROMPT) parts.push(process.env.SYSTEM_PROMPT);
  const memory = opts.memory === false ? { text: '', files: [] } : buildMemoryContext(opts);
  if (memory.text) parts.push(memory.text);
  return { text: parts.join('\n\n'), files: memory.files };
}
