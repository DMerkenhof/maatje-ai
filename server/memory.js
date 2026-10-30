// Het geheugen: gewone markdown-bestanden, in twee gescheiden ruimtes.
//
//   /data/memory                 zakelijk: voor gewone chats (gewone bestanden met git)
//   /data/memory-private.vault   privé: alleen voor privéchats, versleuteld met je code (zie vault.js)
//
// Elke ruimte heeft dezelfde indeling:
//   profile.md       wie je bent
//   preferences.md   hoe het model zich moet gedragen
//   people/          één bestand per persoon of bedrijf
//   areas/           één bestand per project of lopende klus
//   topics/          de rest, per onderwerp
//
// Een chat ziet alleen de memory van zijn eigen ruimte.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import * as vault from './vault.js';

const SUBDIRS = ['people', 'areas', 'topics'];
const PATH_RE = /^\/(?:(?:profile|preferences)|(?:people|areas|topics)\/[a-z0-9][a-z0-9-]{0,80})\.md$/;
export const SPACES = ['work', 'private'];
const VAULT_FILE = 'memory-private.vault';
const LEGACY_PRIVATE_DIR = 'memory-private'; // versie 13 bewaarde privé nog onversleuteld
const VAULT_MAGIC = Buffer.from('MAV1');
const VAULT_AAD = 'maatje-private-memory';

export const validPath = (p) => typeof p === 'string' && PATH_RE.test(p);
export const validSpace = (s) => SPACES.includes(s);
export const spaceOf = (s) => (s === 'private' ? 'private' : 'work');

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Bestanden lezen (los van een ruimte) ----------

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

// ---------- Eén ruimte ----------

const TOP_FILES = ['/profile.md', '/preferences.md'];
const orderKey = (p) => (p === '/profile.md' ? '0' : p === '/preferences.md' ? '1' : `2${SUBDIRS.indexOf(p.split('/')[1])}${p}`);

class BaseSpace {
  // Zoekt bestanden waarvan de naam of een alias in de tekst voorkomt.
  matchFiles(text, { limit = 4, files = this.listFiles() } = {}) {
    const hay = ` ${String(text || '').toLowerCase()} `;
    if (!hay.trim()) return [];
    const scored = [];
    for (const f of files) {
      if (TOP_FILES.includes(f.path)) continue;
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
}

const fileInfo = (rel, content, size, updated) => {
  const meta = parseFile(content);
  return { path: rel, name: meta.name || path.basename(rel, '.md'), description: meta.description, aliases: meta.aliases, size, updated };
};

const cleanText = (content) => {
  let text = String(content).replace(/\r\n/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
};

// Zakelijk: gewone bestanden in een map, met git-geschiedenis.
class MemorySpace extends BaseSpace {
  constructor(name, root) {
    super();
    this.name = name;
    this.root = root;
    this.gitReady = false;
    this.commitQueue = Promise.resolve();
    for (const sub of SUBDIRS) fs.mkdirSync(path.join(root, sub), { recursive: true });
  }

  abs(p) { return path.join(this.root, p); }

  git(args, { env = null, timeout = 15000 } = {}) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: this.root, timeout, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
      });
    });
  }

  async initGit() {
    const check = await this.git(['--version']);
    if (!check.ok) {
      console.warn('[memory] git niet gevonden, wijzigingen worden niet bijgehouden');
      return;
    }
    if (!fs.existsSync(path.join(this.root, '.git'))) await this.git(['init', '-q']);
    await this.git(['config', 'user.name', 'Maatje AI']);
    await this.git(['config', 'user.email', 'chat@localhost']);
    this.gitReady = true;
    await this.commit('memory: begintoestand');
  }

  // Git-klussen na elkaar, nooit door elkaar heen. Een mislukte klus houdt de rij niet op.
  enqueue(fn) {
    const p = this.commitQueue.then(fn);
    this.commitQueue = p.catch(() => {});
    return p;
  }

  // Wijzigingen vastleggen.
  commit(message) {
    return this.enqueue(async () => {
      if (!this.gitReady) return;
      await this.git(['add', '-A']);
      const status = await this.git(['status', '--porcelain']);
      if (!status.out.trim()) return;
      await this.git(['commit', '-q', '-m', message]);
    });
  }

  // Paden die ooit van zakelijk naar privé zijn verplaatst (volgens de geschiedenis).
  async movedToPrivate() {
    const r = await this.git(['log', '--all', '--format=%B']);
    if (!r.ok) return [];
    const out = new Set();
    for (const m of r.out.matchAll(/verplaatst naar privé (\/[a-z0-9/-]+\.md)/g)) if (validPath(m[1])) out.add(m[1]);
    return [...out];
  }

  async history(limit = 15) {
    if (!this.gitReady) return [];
    const r = await this.git(['log', `-n${limit}`, '--date=iso-strict', '--name-status', '--pretty=format:@@%H|%ad|%s']);
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

  // Haalt bestanden helemaal uit de git-geschiedenis, bijvoorbeeld na verplaatsen naar privé.
  // Anders staat de oude, onversleutelde inhoud nog in eerdere versies. Ook de paden in de
  // commitberichten gaan eruit. Geeft true terug als er daarna echt niks meer van te vinden is.
  purgeFromHistory(paths) {
    const wanted = [...new Set(paths)].filter((p) => validPath(p) && !TOP_FILES.includes(p));
    if (!wanted.length) return Promise.resolve(true);
    return this.enqueue(async () => {
      if (!this.gitReady) return false;
      const head = await this.git(['rev-parse', '--verify', '-q', 'HEAD']);
      if (!head.ok) return true; // nog geen geschiedenis
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        // Werkmap eerst schoon, anders weigert filter-branch.
        await this.git(['add', '-A']);
        const st = await this.git(['status', '--porcelain']);
        if (st.out.trim()) await this.git(['commit', '-q', '-m', 'memory: tussentijds vastgelegd']);
        // Een bestand dat nu (weer) zakelijk is, laten we staan: anders verdwijnt het ook uit de werkmap.
        const rel = wanted.filter((p) => !fs.existsSync(this.abs(p))).map((p) => p.slice(1));
        if (!rel.length) return true;
        // Paden bestaan alleen uit a-z, 0-9, streepjes en slashes (zie PATH_RE), dus veilig om te quoten.
        const list = rel.map((p) => `'${p}'`).join(' ');
        const sedExpr = rel.map((p) => `-e 's#/${p.replace(/\./g, '\\.')}#[privé]#g'`).join(' ');
        const r = await this.git(
          ['filter-branch', '--force', '--index-filter', `git rm -q -r --cached --ignore-unmatch -- ${list}`,
            '--msg-filter', `sed ${sedExpr}`, '--prune-empty', '--', '--all'],
          { env: { FILTER_BRANCH_SQUELCH_WARNING: '1' }, timeout: 600000 }
        );
        fs.rmSync(path.join(this.root, '.git', 'refs', 'original'), { recursive: true, force: true });
        if (!r.ok) {
          lastErr = r.err.trim().split('\n').pop();
          continue;
        }
        await this.git(['reflog', 'expire', '--expire=now', '--all']);
        await this.git(['gc', '--prune=now', '-q'], { timeout: 600000 });
        // Controleren: geen versies en geen namen meer.
        const left = await this.git(['log', '--all', '--format=%H', '--', ...rel]);
        const msgs = await this.git(['log', '--all', '--format=%B']);
        if (left.ok && !left.out.trim() && msgs.ok && !rel.some((p) => msgs.out.includes(`/${p}`))) return true;
        lastErr = 'er staan nog sporen in de geschiedenis';
      }
      console.warn(`[memory] oude versies uit de zakelijke geschiedenis halen lukte niet (${lastErr}); de app probeert het opnieuw bij het openen van Privé`);
      return false;
    });
  }

  readFile(p) {
    if (!validPath(p)) return null;
    try { return fs.readFileSync(this.abs(p), 'utf8'); } catch { return null; }
  }

  writeFile(p, content) {
    if (!validPath(p)) throw new Error('Ongeldig pad');
    fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true });
    fs.writeFileSync(this.abs(p), cleanText(content), 'utf8');
  }

  deleteFile(p) {
    if (!validPath(p)) throw new Error('Ongeldig pad');
    fs.rmSync(this.abs(p), { force: true });
  }

  listFiles() {
    return listDir(this.root);
  }
}

// Alle memory-bestanden in een map (ook voor het overzetten van de oude privémap).
function listDir(root, { withContent = false } = {}) {
  const files = [];
  const add = (rel) => {
    const full = path.join(root, rel);
    let stat;
    let content;
    try {
      stat = fs.statSync(full);
      content = fs.readFileSync(full, 'utf8');
    } catch { return; }
    const info = fileInfo(rel, content, stat.size, stat.mtimeMs);
    if (withContent) info.content = content;
    files.push(info);
  };
  for (const top of TOP_FILES) if (fs.existsSync(path.join(root, top))) add(top);
  for (const sub of SUBDIRS) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, sub)); } catch {}
    for (const n of names.sort()) {
      if (n.endsWith('.md') && validPath(`/${sub}/${n}`)) add(`/${sub}/${n}`);
    }
  }
  return files;
}

function atomicWrite(file, buf) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Privé: alle bestanden samen in één versleuteld bestand, met de geschiedenis erin.
// Ook de bestandsnamen zijn dus niet te zien zonder je code.
class VaultSpace extends BaseSpace {
  constructor(name, file) {
    super();
    this.name = name;
    this.file = file;
    this.cache = null;
    this.pending = new Map(); // pad -> 'A' | 'M' | 'D' sinds de laatste commit
    vault.onLock(() => {
      this.cache = null;
      this.pending.clear();
    });
  }

  load() {
    if (!vault.isOpen()) throw new vault.LockedError(vault.isSetup());
    if (this.cache) return this.cache;
    let data = { v: 1, files: {}, history: [] };
    if (fs.existsSync(this.file)) {
      const blob = fs.readFileSync(this.file);
      if (!blob.subarray(0, 4).equals(VAULT_MAGIC)) throw new Error('Het bestand met je privé-memory is onbekend of beschadigd');
      data = JSON.parse(vault.decryptBuffer(blob.subarray(4), VAULT_AAD).toString('utf8'));
    }
    this.cache = data;
    return data;
  }

  save() {
    const data = this.load();
    try {
      const blob = vault.encryptBuffer(Buffer.from(JSON.stringify(data), 'utf8'), VAULT_AAD);
      atomicWrite(this.file, Buffer.concat([VAULT_MAGIC, blob]));
    } catch (err) {
      // Niet bewaard (bijv. schijf vol): wat in het geheugen staat mag niet afwijken van de schijf.
      this.cache = null;
      this.pending.clear();
      throw err;
    }
  }

  // Opnieuw van schijf lezen (om te controleren wat er echt staat).
  reload() {
    this.cache = null;
    return this.load();
  }

  // Paden die nog uit de zakelijke geschiedenis moeten (versleuteld bewaard: het zijn privénamen).
  pendingPurge() {
    return [...(this.load().purge || [])];
  }

  addPendingPurge(paths) {
    const d = this.load();
    const next = new Set([...(d.purge || []), ...paths.filter((p) => validPath(p) && !TOP_FILES.includes(p))]);
    if (next.size === (d.purge || []).length) return;
    d.purge = [...next];
    this.save();
  }

  clearPendingPurge(paths) {
    const d = this.load();
    const drop = new Set(paths);
    const next = (d.purge || []).filter((p) => !drop.has(p));
    if (next.length === (d.purge || []).length) return;
    d.purge = next;
    this.save();
  }

  readFile(p) {
    if (!validPath(p)) return null;
    const f = this.load().files[p];
    return f ? f.content : null;
  }

  writeFile(p, content) {
    if (!validPath(p)) throw new Error('Ongeldig pad');
    const d = this.load();
    const had = Boolean(d.files[p]);
    d.files[p] = { content: cleanText(content), updated: Date.now() };
    const prev = this.pending.get(p);
    this.pending.set(p, prev === 'A' || (!had && prev !== 'D') ? 'A' : 'M');
    this.save();
  }

  deleteFile(p) {
    if (!validPath(p)) throw new Error('Ongeldig pad');
    const d = this.load();
    if (!d.files[p]) return;
    delete d.files[p];
    if (this.pending.get(p) === 'A') this.pending.delete(p);
    else this.pending.set(p, 'D');
    this.save();
  }

  listFiles() {
    const d = this.load();
    return Object.entries(d.files)
      .filter(([p]) => validPath(p))
      .sort(([a], [b]) => orderKey(a).localeCompare(orderKey(b)))
      .map(([p, f]) => fileInfo(p, f.content, Buffer.byteLength(f.content), f.updated));
  }

  commit(message) {
    if (!this.pending.size) return Promise.resolve();
    const d = this.load();
    d.history.unshift({
      hash: crypto.randomBytes(4).toString('hex'),
      date: new Date().toISOString(),
      message,
      files: [...this.pending].map(([p, status]) => ({ status, path: p })),
    });
    d.history = d.history.slice(0, 300);
    this.pending.clear();
    this.save();
    return Promise.resolve();
  }

  async history(limit = 15) {
    return this.load().history.slice(0, limit);
  }

  // Gooit alles weg (bij "code vergeten").
  destroy() {
    this.cache = null;
    this.pending.clear();
    fs.rmSync(this.file, { force: true });
  }
}

const spaces = {};
let legacyDir = null;

export function ensureMemoryDirs(dataDir) {
  spaces.work = new MemorySpace('work', path.join(dataDir, 'memory'));
  spaces.work.initGit();
  spaces.private = new VaultSpace('private', path.join(dataDir, VAULT_FILE));
  legacyDir = path.join(dataDir, LEGACY_PRIVATE_DIR);
}

export const hasLegacyPrivate = () => Boolean(legacyDir && fs.existsSync(legacyDir));

// Alle .md-bestanden in de oude privémap, ook met namen die niet in de indeling passen.
function scanLegacy(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push({ orig: r, content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(root, '');
  for (const f of out) f.path = validPath(f.orig) ? f.orig : tidyPath(f.orig);
  return out;
}

function tidyPath(rel) {
  const parts = rel.split('/').filter(Boolean);
  const name = parts.pop().replace(/\.md$/i, '');
  const folder = SUBDIRS.includes(parts[0]) ? parts[0] : 'topics';
  let slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  if (!slug) slug = 'bestand';
  return `/${folder}/${slug}.md`;
}

// Een vrij pad naast een bestaand bestand, bijv. /people/oma-v13.md.
function freePath(space, p, suffix) {
  const base = p.replace(/\.md$/, '');
  if (TOP_FILES.includes(p)) return freePath(space, `/topics${base}${suffix}.md`, '');
  for (let i = 1; i < 100; i++) {
    const cand = `${base}${suffix}${i > 1 ? `-${i}` : ''}.md`;
    if (validPath(cand) && space.readFile(cand) === null) return cand;
  }
  return null;
}

// Haalt wat nog in de wachtrij staat uit de zakelijke geschiedenis. Alleen met open kluis.
export async function runPendingPurges() {
  const v = spaces.private;
  const work = spaces.work;
  const list = v.pendingPurge();
  if (!list.length) return true;
  const ok = await work.purgeFromHistory(list);
  if (ok) v.clearPendingPurge(list);
  return ok;
}

// Zet de onversleutelde privémap van versie 13 over naar de kluis en wist hem daarna.
// Bestanden die eerder van zakelijk naar privé zijn verplaatst, gaan ook uit de zakelijke geschiedenis.
export async function migrateLegacyPrivate() {
  const v = spaces.private;
  const work = spaces.work;
  const result = { imported: 0, kept: false };
  if (hasLegacyPrivate()) {
    const files = scanLegacy(legacyDir);
    const expect = [];
    for (const f of files) {
      const text = cleanText(f.content);
      const cur = v.readFile(f.path);
      let target = f.path;
      if (cur !== null && cur !== text) target = freePath(v, f.path, '-v13'); // verschilt: allebei bewaren
      if (!target) { result.kept = true; continue; }
      if (cur === null || target !== f.path) {
        v.writeFile(target, f.content);
        result.imported++;
      }
      expect.push({ target, text });
    }
    if (result.imported) await v.commit('memory: begintoestand (versleuteld)');
    // Wat ooit van zakelijk hierheen kwam, moet ook uit de zakelijke geschiedenis.
    v.addPendingPurge(files.map((f) => f.orig).filter((p) => validPath(p) && work.readFile(p) === null));
    // Pas wissen als alles echt versleuteld op schijf staat.
    v.reload();
    const allThere = !result.kept && expect.every((e) => v.readFile(e.target) === e.text);
    if (allThere) fs.rmSync(legacyDir, { recursive: true, force: true });
    else {
      result.kept = true;
      console.warn('[privé] niet alles uit de oude privémap kon worden overgezet; de map blijft staan');
    }
  }
  v.addPendingPurge((await work.movedToPrivate()).filter((p) => work.readFile(p) === null));
  result.purged = await runPendingPurges();
  return result;
}

// De ruimte voor zakelijke ('work') of privé ('private') chats.
export function space(name = 'work') {
  return spaces[spaceOf(name)];
}

// ---------- Context voor het chatmodel ----------

export function memoryReadTool() {
  return {
    type: 'function',
    function: {
      name: 'memory_read',
      description: 'Lees een of meer bestanden uit het geheugen van de gebruiker. Gebruik de paden uit de lijst met bestanden.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Paden, bijv. ["/people/jan-de-vries.md"]' },
        },
        required: ['paths'],
      },
    },
  };
}

export function runMemoryRead(args, spaceName = 'work') {
  const m = space(spaceName);
  const paths = Array.isArray(args?.paths) ? args.paths : typeof args?.path === 'string' ? [args.path] : [];
  const out = [];
  const read = [];
  for (const p of paths.slice(0, 8)) {
    const content = m.readFile(p);
    if (content === null) out.push(`=== ${p} ===\n(bestaat niet)`);
    else {
      out.push(`=== ${p} ===\n${clip(content, 12000)}`);
      read.push(p);
    }
  }
  return { text: out.join('\n\n') || '(geen paden opgegeven)', read };
}

// Bouwt het geheugendeel van de systeemprompt. Geeft ook terug welke bestanden erin staan.
export function buildMemoryContext({ recentText = '', withTool = false, compact = false, space: spaceName = 'work' } = {}) {
  const m = space(spaceName);
  if (!m) return { text: '', files: [] };
  const files = m.listFiles();
  if (!files.length) return { text: '', files: [] };

  const profile = parseFile(m.readFile('/profile.md') || '').body.trim();
  const prefs = parseFile(m.readFile('/preferences.md') || '').body.trim();
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

  const matched = m.matchFiles(recentText, { files, limit: compact ? 3 : 4 });
  let budget = compact ? 9000 : 16000;
  const included = [];
  for (const f of matched) {
    if (budget <= 500) break;
    const body = parseFile(m.readFile(f.path) || '').body.trim();
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
  if (listing) {
    parts.push(
      `### Bestanden in het geheugen\n` +
        (withTool
          ? 'Lijkt een bestand relevant voor de vraag, open het dan met de tool memory_read voordat je antwoordt. Zeg nooit dat je iets niet weet zonder eerst het passende bestand te lezen.\n'
          : 'Bestanden die bij dit gesprek lijken te horen, staan hieronder al uitgeschreven. Van de andere zie je alleen de omschrijving.\n') +
        listing
    );
  }
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
  if (opts.space === 'private') parts.push('Dit is een privéchat. Je ziet hier alleen de privé-memory van de gebruiker; zijn zakelijke memory hoort niet bij deze chat.');
  const memory = opts.memory === false ? { text: '', files: [] } : buildMemoryContext(opts);
  if (memory.text) parts.push(memory.text);
  return { text: parts.join('\n\n'), files: memory.files };
}
