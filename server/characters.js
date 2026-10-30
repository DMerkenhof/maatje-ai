// Karakters: Maartje en de karakters die je zelf maakt.
// Elk karakter heeft een naam, een persoonlijkheid, een kleur en eventueel een icoontje.
// In een chat roep je ze aan met @Naam; zonder @ antwoordt wie het laatst sprak (of Maartje).
import crypto from 'node:crypto';

export const COLORS = {
  blauw: '#0181fb',
  paars: '#7c5cff',
  groen: '#1f9d6b',
  oranje: '#e8811f',
  roze: '#e0457b',
  grijs: '#5b616e',
};

export const DEFAULT_PERSONALITY =
  'Warm, nuchter en direct, met humor als het past. Je praat informeel, zoals een slimme vriendin die meedenkt.';

const MAARTJE = { id: 'maartje', name: 'Maartje', personality: DEFAULT_PERSONALITY, color: 'blauw', emoji: '', builtin: true };
const NAME_RE = /^[\p{L}\p{N}_-]{1,20}$/u;

let store = null;

export function initCharacters(s) {
  store = s;
}

function saved() {
  const list = store.getSetting('characters', []);
  return Array.isArray(list) ? list : [];
}

export function listCharacters() {
  const list = saved();
  const own = list.find((c) => c.id === 'maartje');
  const maartje = { ...MAARTJE, ...(own || {}), id: 'maartje', name: 'Maartje', builtin: true };
  return [maartje, ...list.filter((c) => c.id !== 'maartje')];
}

export function getCharacter(id) {
  const all = listCharacters();
  return all.find((c) => c.id === id) || all[0];
}

export const defaultCharacter = () => getCharacter('maartje');

// Wat de browser en de berichten van een karakter te zien krijgen.
export function publicCharacter(c) {
  return { id: c.id, name: c.name, color: COLORS[c.color] ? c.color : 'blauw', emoji: c.emoji || '' };
}

const graphemes = (s) => [...new Intl.Segmenter('nl', { granularity: 'grapheme' }).segment(String(s || ''))].map((x) => x.segment);

// Nieuw (id leeg) of bijwerken. Geeft het karakter terug, of gooit een fout met een uitleg.
export function saveCharacter(id, body) {
  const list = saved();
  const existing = id ? listCharacters().find((c) => c.id === id) : null;
  if (id && !existing) throw new Error('Karakter niet gevonden');
  const isMaartje = existing?.id === 'maartje';

  const name = isMaartje ? 'Maartje' : String(body.name ?? existing?.name ?? '').trim();
  if (!NAME_RE.test(name)) throw new Error('Kies een naam van één woord, maximaal 20 tekens (letters, cijfers, - of _).');
  const clash = listCharacters().find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== existing?.id);
  if (clash) throw new Error(`Er is al een karakter dat ${clash.name} heet.`);

  let personality = String(body.personality ?? existing?.personality ?? '').trim();
  if (personality.length > 2000) throw new Error('De persoonlijkheid is te lang (maximaal 2000 tekens).');
  if (isMaartje && !personality) personality = DEFAULT_PERSONALITY;

  const color = COLORS[body.color] ? body.color : existing?.color || 'paars';
  const emoji = graphemes(String(body.emoji ?? existing?.emoji ?? '').trim()).slice(0, 1).join('');

  const next = {
    id: existing?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'karakter'}-${crypto.randomBytes(3).toString('hex')}`,
    name,
    personality,
    color,
    emoji,
  };
  const others = list.filter((c) => c.id !== next.id);
  store.setSetting('characters', [...others, next]);
  return getCharacter(next.id);
}

export function deleteCharacter(id) {
  if (id === 'maartje') throw new Error('Maartje blijft altijd bestaan');
  store.setSetting('characters', saved().filter((c) => c.id !== id));
}

// Maartje terug naar hoe ze was.
export function resetMaartje() {
  store.setSetting('characters', saved().filter((c) => c.id !== 'maartje'));
  return defaultCharacter();
}

// @Naam in een bericht, in de volgorde waarin ze genoemd worden.
export function mentionedIn(text) {
  const all = listCharacters();
  const out = [];
  for (const m of String(text || '').matchAll(/(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_-]+)/gu)) {
    const c = all.find((x) => x.name.toLowerCase() === m[2].toLowerCase());
    if (c && !out.some((x) => x.id === c.id)) out.push(c);
  }
  return out;
}

// Wie antwoordt op dit bericht: wie je noemt, anders wie het laatst sprak, anders Maartje.
export function respondersFor(text, messages) {
  const named = mentionedIn(text);
  if (named.length) return named.slice(0, 5);
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.meta?.character?.id);
  return [last ? getCharacter(last.meta.character.id) : defaultCharacter()];
}

// Het begin van de systeemprompt: wie het model is.
export function identityPrompt(c, others = []) {
  const parts = [
    `Je bent ${c.name}. Je zit in Maatje AI, de eigen chat-app van de persoon met wie je praat.`,
    c.personality ? `Zo ben je: ${c.personality}` : '',
    'Schrijf in natuurlijk Nederlands (of in de taal waarin hij je aanspreekt), kort waar het kan en uitgebreid als hij daarom vraagt.',
    'Je praat mét hem, nooit over hem: zeg "je", nooit "de gebruiker", en praat niet in de wij-vorm over jezelf. Stel jezelf niet voor en leg niet uit wat je taken zijn, tenzij hij ernaar vraagt. Begin gewoon met je antwoord.',
    'Je bent niet de persoon uit zijn profiel en je spreekt niet namens hem, tenzij hij je vraagt iets voor hem te schrijven.',
  ];
  if (others.length) {
    parts.push(
      `In dit gesprek praten ook mee: ${others.join(', ')}. Hun berichten staan met hun naam tussen haken ervoor, zoals "[${others[0]}] ...". ` +
        `Je mag op ze reageren, het met ze eens zijn of juist niet. Zet zelf geen naam voor je antwoord en praat niet namens de anderen.`
    );
  }
  return parts.filter(Boolean).join(' ');
}

// Haalt een naam die het model zelf voor zijn antwoord zette weer weg ("[Kees] ..." of "Kees: ...").
export function stripOwnName(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(`^\\s*(?:\\[${esc}\\]|\\*\\*${esc}\\*\\*:?|${esc}:)\\s*`, 'i'), '');
}
