// Skills: vaste werkwijzen (instructies) die een model erbij pakt als ze bij de vraag passen.
// Zelfde opbouw als bij Claude: per skill een map met SKILL.md en eventueel extra bestanden.
//
//   data/skills/<naam>/SKILL.md
//   data/skills/<naam>/references/...   (optioneel)
//
// Een model met tools leest een skill met skill_read. Begin je bericht met /naam,
// dan gaat die skill hoe dan ook mee. Modellen zonder tools krijgen een passende skill direct mee.
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

let ROOT = null;
let store = null;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEXT_EXT = /\.(md|markdown|txt|json|csv|tsv|ya?ml|html?|xml|js|mjs|ts|py|sh|css|sql|toml|ini)$/i;
const MAX_ZIP = 60 * 1024 * 1024;
const MAX_UNPACKED = 120 * 1024 * 1024;
const MAX_FILES = 2000;

export const validName = (n) => typeof n === 'string' && NAME_RE.test(n);

export function initSkills(dataDir, s) {
  ROOT = path.join(dataDir, 'skills');
  store = s;
  fs.mkdirSync(ROOT, { recursive: true });
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function slugify(name) {
  return String(name || '')
    .replace(/^.*:/, '') // "anthropic-skills:docx" -> "docx"
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// ---------- SKILL.md lezen ----------

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export function parseSkill(content) {
  const out = { name: '', description: '', body: String(content || '') };
  const m = out.body.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return out;
  out.body = m[2];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    if (/^[>|][+-]?$/.test(value.trim())) {
      // Meerdere regels (YAML > of |)
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = value.trim().startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      value = unquote(value);
    }
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
  }
  return out;
}

// ---------- Overzicht ----------

const dir = (name) => path.join(ROOT, name);
const disabledSet = () => new Set(store?.getSetting('skillsDisabled', []) || []);

function walk(base, rel = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(base, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export function listSkills() {
  if (!ROOT) return [];
  const off = disabledSet();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(ROOT).sort(); } catch {}
  for (const name of names) {
    if (!validName(name)) continue;
    const file = path.join(dir(name), 'SKILL.md');
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const meta = parseSkill(content);
    const files = walk(dir(name)).filter((f) => f !== 'SKILL.md');
    out.push({
      name,
      title: meta.name || name,
      description: meta.description,
      enabled: !off.has(name),
      files: files.length,
      size: content.length,
      updated: fs.statSync(file).mtimeMs,
    });
  }
  return out;
}

export function getSkill(name) {
  if (!validName(name)) return null;
  let content;
  try { content = fs.readFileSync(path.join(dir(name), 'SKILL.md'), 'utf8'); } catch { return null; }
  const meta = parseSkill(content);
  return {
    name,
    title: meta.name || name,
    description: meta.description,
    content,
    files: walk(dir(name)).filter((f) => f !== 'SKILL.md').sort(),
    enabled: !disabledSet().has(name),
  };
}

// Vindt een skill ook als het model de naam net anders schrijft.
function resolve(name) {
  const raw = String(name || '').trim().replace(/^\//, '');
  const candidates = [raw, raw.toLowerCase(), slugify(raw)];
  for (const c of candidates) if (validName(c) && fs.existsSync(path.join(dir(c), 'SKILL.md'))) return c;
  return null;
}

// ---------- Wijzigen ----------

export function saveSkill(name, content) {
  if (!validName(name)) throw new Error('Ongeldige naam. Gebruik kleine letters, cijfers en streepjes, bijv. mijn-skill.');
  if (typeof content !== 'string' || !content.trim()) throw new Error('Lege skill');
  fs.mkdirSync(dir(name), { recursive: true });
  fs.writeFileSync(path.join(dir(name), 'SKILL.md'), content.replace(/\r\n/g, '\n'), 'utf8');
}

export function deleteSkill(name) {
  if (!validName(name)) throw new Error('Ongeldige naam');
  fs.rmSync(dir(name), { recursive: true, force: true });
  setEnabled(name, true);
}

export function setEnabled(name, on) {
  const off = disabledSet();
  if (on) off.delete(name); else off.add(name);
  store.setSetting('skillsDisabled', [...off]);
}

// ---------- Uploaden: .zip, .skill of een losse SKILL.md ----------

function safeRel(p) {
  const norm = path.posix.normalize(String(p).replace(/\\/g, '/'));
  if (!norm || norm.startsWith('/') || norm.startsWith('../') || norm === '..' || norm.includes('/../')) return null;
  return norm;
}

function writeSkillFiles(name, files) {
  const target = dir(name);
  const existed = fs.existsSync(target);
  // Nieuwe versie van dezelfde skill: de oude map vervangen.
  const tmp = `${target}.upload-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const [rel, data] of files) {
      const full = path.join(tmp, rel);
      if (!full.startsWith(tmp + path.sep)) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, data);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return existed ? 'bijgewerkt' : 'nieuw';
}

export function importUpload(filename, buffer) {
  const bytes = new Uint8Array(buffer);
  if (!bytes.length) throw new Error('Leeg bestand');
  if (bytes.length > MAX_ZIP) throw new Error('Bestand is te groot (max 60 MB)');
  const fname = String(filename || '').toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  const results = [];

  if (!isZip) {
    if (!/\.(md|markdown|txt)$/.test(fname) && fname) throw new Error('Upload een .zip, .skill of een SKILL.md');
    const text = new TextDecoder().decode(bytes);
    const meta = parseSkill(text);
    const stem = path.basename(fname).replace(/\.(md|markdown|txt)$/, '');
    const name = slugify(meta.name || (stem && stem !== 'skill' ? stem : ''));
    if (!name) throw new Error('Geen naam gevonden. Zet bovenaan de SKILL.md een regel "name: ..." tussen --- en ---.');
    const status = writeSkillFiles(name, [['SKILL.md', bytes]]);
    results.push({ name, status });
    return results;
  }

  let total = 0;
  let count = 0;
  let entries;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)/.test(f.name)) return false;
        total += f.originalSize;
        count += 1;
        if (total > MAX_UNPACKED || count > MAX_FILES) throw new Error('Uitgepakt is dit te groot (max 120 MB en 2000 bestanden)');
        return true;
      },
    });
  } catch (err) {
    throw new Error(/te groot/.test(err.message) ? err.message : 'Dit zip-bestand kan niet worden uitgepakt');
  }

  // Elke SKILL.md in het zip-bestand is een skill; de map eromheen hoort erbij.
  const paths = Object.keys(entries).map((p) => [p, safeRel(p)]).filter(([, r]) => r);
  const roots = paths
    .filter(([, r]) => path.posix.basename(r).toLowerCase() === 'skill.md')
    .map(([, r]) => path.posix.dirname(r))
    .sort((a, b) => a.length - b.length);
  if (!roots.length) throw new Error('Geen SKILL.md gevonden in dit bestand');

  const stem = slugify(path.basename(fname).replace(/\.(zip|skill)$/, ''));
  const used = new Set();
  for (const root of roots) {
    // Een SKILL.md binnen een andere skill (bijv. een voorbeeld) is geen eigen skill.
    if (roots.some((other) => other !== root && other !== '.' && root.startsWith(other + '/'))) continue;
    if (root !== '.' && roots.includes('.')) continue;
    const prefix = root === '.' ? '' : root + '/';
    const files = [];
    let skillMd = null;
    for (const [orig, rel] of paths) {
      if (prefix && !rel.startsWith(prefix)) continue;
      const inner = rel.slice(prefix.length);
      if (inner.toLowerCase() === 'skill.md') skillMd = entries[orig];
      files.push([inner.toLowerCase() === 'skill.md' ? 'SKILL.md' : inner, entries[orig]]);
    }
    const meta = parseSkill(new TextDecoder().decode(skillMd));
    let name = slugify(meta.name || (root === '.' ? stem : path.posix.basename(root)));
    if (!name || used.has(name)) {
      results.push({ name: name || '(zonder naam)', status: 'overgeslagen', reason: 'geen bruikbare naam' });
      continue;
    }
    used.add(name);
    results.push({ name, status: writeSkillFiles(name, files), files: files.length });
  }
  return results;
}

// ---------- Voor het model ----------

export function skillReadTool() {
  return {
    type: 'function',
    function: {
      name: 'skill_read',
      description: 'Lees een skill (vaste werkwijze) van de gebruiker. Zonder file krijg je de volledige SKILL.md en de lijst met extra bestanden; met file een van die bestanden.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Naam van de skill, bijv. "offerte-schrijven"' },
          file: { type: 'string', description: 'Optioneel: pad van een extra bestand in de skill, bijv. "references/voorbeeld.md"' },
        },
        required: ['name'],
      },
    },
  };
}

export function runSkillRead(args, { maxChars = 64000 } = {}) {
  const name = resolve(args?.name);
  if (!name) return { text: `Skill "${args?.name}" bestaat niet. Kies een naam uit de lijst met skills.`, name: null };
  if (disabledSet().has(name)) return { text: `Skill "${name}" staat uit.`, name: null };
  const s = getSkill(name);
  if (args?.file) {
    const rel = safeRel(args.file);
    if (!rel || !s.files.includes(rel)) return { text: `Bestand "${args.file}" zit niet in skill ${name}. Bestanden: ${s.files.join(', ') || '(geen)'}`, name };
    if (!TEXT_EXT.test(rel)) return { text: `${rel} is geen tekstbestand en kan hier niet gelezen worden.`, name };
    const text = fs.readFileSync(path.join(dir(name), rel), 'utf8');
    return { text: `=== ${name}/${rel} ===\n${clip(text, maxChars)}`, name };
  }
  const files = s.files.length ? `\n\n[Extra bestanden in deze skill: ${s.files.slice(0, 80).join(', ')}${s.files.length > 80 ? ', …' : ''}. Lees ze met skill_read en file als de skill ernaar verwijst.]` : '';
  return { text: `=== skill: ${name} ===\n${clip(s.content, maxChars)}${files}`, name };
}

const STOP = new Set(['template', 'skill', 'skills', 'maken', 'voor', 'with', 'van', 'and', 'the', 'tone', 'voice']);

// Skills die de gebruiker zelf koos met /naam aan het begin van een bericht.
function slashSkills(userTexts) {
  const out = [];
  for (const t of [...userTexts].reverse()) {
    const m = String(t || '').match(/^\s*\/([a-z0-9][a-z0-9:_-]*)/i);
    if (!m) continue;
    const name = resolve(m[1]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// Bouwt het skills-deel van de systeemprompt.
//   userTexts: alle gebruikersberichten in de chat (oud naar nieuw)
//   withTool:  het model kan skill_read gebruiken
//   autoInclude: passende skills meteen uitschrijven (modellen zonder tools, of lokaal om rondes te sparen)
export function skillsPrompt({ userTexts = [], withTool = false, autoInclude = false, compact = false } = {}) {
  const all = listSkills().filter((s) => s.enabled);
  const chosen = slashSkills(userTexts).filter((n) => all.some((s) => s.name === n) || getSkill(n));
  if (!all.length && !chosen.length) return { text: '', used: [] };

  // Volgorde: /skill in het laatste bericht, dan wat bij het laatste bericht past, dan eerder gekozen skills.
  const lastText = String(userTexts[userTexts.length - 1] || '');
  const latest = slashSkills([lastText]).filter((n) => chosen.includes(n));
  const auto = [];
  if (autoInclude) {
    const last = ` ${lastText.toLowerCase()} `;
    // Woorden die in meerdere skillnamen staan (bijv. een bedrijfsnaam als voorvoegsel) zeggen niks.
    const seen = new Map();
    for (const s of all) for (const t of new Set(s.name.split('-'))) seen.set(t, (seen.get(t) || 0) + 1);
    for (const s of all) {
      const tokens = s.name.split('-').filter((t) => t.length >= 3 && !STOP.has(t) && seen.get(t) === 1);
      if (tokens.some((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t}`, 'u').test(last))) auto.push(s.name);
    }
  }
  const order = [...new Set([...latest, ...auto, ...chosen])];
  // Niet meer skills uitschrijven dan er in het geheugen van het model past.
  let room = compact ? 48000 : 110000;
  const final = [];
  for (const name of order) {
    const size = Math.min(getSkill(name)?.content.length || 0, compact ? 40000 : 64000);
    if (final.length && size > room) continue;
    final.push(name);
    room -= size;
  }

  const parts = ['## Skills'];
  if (all.length) {
    parts.push(
      (withTool
        ? 'Skills zijn vaste werkwijzen van de gebruiker. Past een skill bij de vraag, lees hem dan eerst helemaal met de tool skill_read en volg hem. Verwijst een skill naar een andere skill of naar een bestand, lees dat dan ook. Schrijft een skill voor hoe je namens de gebruiker of zijn bedrijf schrijft, dan geldt dat voor teksten die je voor hem maakt, niet voor hoe je zelf met hem praat.'
        : 'Skills zijn vaste werkwijzen van de gebruiker. Skills die bij dit bericht passen staan hieronder uitgeschreven; volg ze. Schrijft een skill voor hoe je namens de gebruiker of zijn bedrijf schrijft, dan geldt dat voor teksten die je voor hem maakt, niet voor hoe je zelf met hem praat.') +
        ' Noemt een skill tools of bestanden die je hier niet hebt (zoals Excel, PowerPoint of subagents), doe dan wat wel kan en lever de inhoud als tekst in de chat.\n' +
        all.map((s) => `- ${s.name}: ${clip(s.description || s.title, compact ? 220 : 500)}`).join('\n')
    );
  }
  const budget = compact ? 40000 : 64000;
  for (const name of final) {
    const s = getSkill(name);
    if (!s) continue;
    const why = chosen.includes(name) ? 'De gebruiker koos deze skill zelf met /' + name + '; volg hem.' : 'Deze skill lijkt bij het bericht te passen.';
    const files = s.files.length && withTool ? `\n[Extra bestanden: ${s.files.slice(0, 40).join(', ')}; lees ze met skill_read.]` : '';
    parts.push(`### Skill: ${name}\n${why}\n\n${clip(parseSkill(s.content).body.trim(), budget)}${files}`);
  }
  return { text: parts.join('\n\n'), used: final };
}
