// De kluis voor Privé.
//
// Alles in Privé (je privéchats en je privé-memory) staat versleuteld op schijf, met AES-256-GCM.
// De sleutel daarvan staat zelf ook versleuteld in de database, met een sleutel die uit jouw code
// komt (scrypt). Zonder je code valt er dus niks te lezen, ook niet voor iemand met je Pi of een backup.
//
// Na het openen zit de sleutel alleen in het werkgeheugen van de server. Hij verdwijnt weer:
//   - na 15 minuten zonder activiteit in Privé (PRIVATE_LOCK_MINUTES in .env),
//   - met de knop "Op slot",
//   - bij een herstart van de server.
//
// Elke browser die Privé opent krijgt een eigen sessie. Open je Privé op je telefoon,
// dan staat het op je laptop nog gewoon op slot.
import crypto from 'node:crypto';

export const COOKIE = 'maatje_prive';
const minutes = Number(process.env.PRIVATE_LOCK_MINUTES);
export const IDLE_MS = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;

const KDF = { N: 2 ** 17, r: 8, p: 1 }; // ongeveer 128 MB en een halve tot twee seconden per poging
const MAXMEM = 256 * 1024 * 1024;
const TEXT_PREFIX = 'mv1:';
const KEY_AAD = 'maatje-vault-key';

let store = null;
let dek = null; // de sleutel van Privé, alleen in het geheugen zolang Privé open is
const sessions = new Map(); // hash van sessietoken -> laatste activiteit
let holds = 0; // lopende klussen die de sleutel nog nodig hebben (een antwoord, de memory-bijwerker)
const lockListeners = new Set();
let queue = Promise.resolve(); // scrypt nooit tegelijk (scheelt geheugen op de Pi en remt raden)
let epoch = 0; // telt op bij instellen en wissen, zodat een poging die nog liep daarna niks meer doet

export class LockedError extends Error {
  constructor(setup = true) {
    super(setup ? 'Privé is op slot' : 'Stel eerst een code in voor Privé');
    this.locked = true;
    this.setup = setup;
  }
}

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');
const normCode = (p) => String(p ?? '').normalize('NFC').trim();

function scrypt(code, salt, kdf) {
  const run = () =>
    new Promise((resolve, reject) => {
      crypto.scrypt(normCode(code), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM }, (err, key) =>
        err ? reject(err) : resolve(key)
      );
    });
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

function gcmEncrypt(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function gcmDecrypt(key, blob, aad) {
  if (blob.length < 28) throw new Error('Versleutelde gegevens zijn beschadigd');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

// ---------- Status ----------

export function initVault(s) {
  store = s;
  const t = setInterval(sweep, 10 * 1000);
  t.unref?.();
}

const record = () => store?.getSetting('vault', null) || null;
export const isSetup = () => Boolean(record());
export const isOpen = () => dek !== null;
export const onLock = (fn) => lockListeners.add(fn);

function sweep() {
  const now = Date.now();
  for (const [h, last] of sessions) if (now - last > IDLE_MS) sessions.delete(h);
  if (dek && sessions.size === 0 && holds === 0) wipe();
}

function wipe() {
  const had = dek !== null;
  if (dek) dek.fill(0);
  dek = null;
  sessions.clear();
  if (had) for (const fn of lockListeners) { try { fn(); } catch {} }
}

// Zolang een klus loopt (bijv. een antwoord in een privéchat) blijft de sleutel er.
// Op slot zetten met de knop gaat altijd voor.
export function hold() {
  holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds--;
  };
}

function newSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(hashToken(token), Date.now());
  return token;
}

// Is Privé open voor deze browser? Met touch telt het als activiteit.
// Zijn er browsers met Privé open (en niet verlopen)?
export function activeSessions() {
  const now = Date.now();
  let n = 0;
  for (const last of sessions.values()) if (now - last <= IDLE_MS) n++;
  return n;
}

// Alleen deze browser dicht (bijv. als hij zelf op slot gaat na niks doen).
// Is het de laatste, dan verdwijnt de sleutel bij de volgende ronde van sweep().
export function leave(token) {
  if (typeof token === 'string' && token) sessions.delete(hashToken(token));
  sweep();
}

export function sessionOk(token, { touch = true } = {}) {
  if (!dek || typeof token !== 'string' || !token) return false;
  const h = hashToken(token);
  const last = sessions.get(h);
  if (last === undefined) return false;
  if (Date.now() - last > IDLE_MS) {
    sessions.delete(h);
    return false;
  }
  if (touch) sessions.set(h, Date.now());
  return true;
}

export function status(token) {
  const ok = sessionOk(token, { touch: false });
  const last = ok ? sessions.get(hashToken(token)) : 0;
  return {
    setup: isSetup(),
    unlocked: ok,
    lockMinutes: IDLE_MS / 60000,
    remainingMs: ok ? Math.max(0, IDLE_MS - (Date.now() - last)) : 0,
  };
}

// ---------- Raden afremmen ----------
// Na 5 foute codes vanaf één adres een kwartier wachten, en 20 fouten samen per kwartier.

const attempts = new Map();
const global = { fails: [], until: 0 };
const FAIL_WINDOW = 15 * 60 * 1000;

function waitMinutes(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  const until = Math.max(a?.until || 0, global.until);
  return until > now ? Math.ceil((until - now) / 60000) : 0;
}

// Telt een poging alvast als fout. Klopt de code toch, dan draait undoFail dat terug.
function registerFail(ip) {
  const now = Date.now();
  const mark = { at: now, globalLock: false, ipLock: false };
  global.fails = global.fails.filter((t) => t > now - FAIL_WINDOW);
  global.fails.push(now);
  if (global.fails.length >= 20) {
    global.fails = [];
    global.until = now + FAIL_WINDOW;
    mark.globalLock = true;
  }
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= 5) {
    a.fails = 0;
    a.until = now + FAIL_WINDOW;
    mark.ipLock = true;
  }
  attempts.set(ip, a);
  return mark;
}

function undoFail(ip, mark) {
  const i = global.fails.lastIndexOf(mark.at);
  if (i >= 0) global.fails.splice(i, 1);
  if (mark.globalLock) global.until = 0;
  attempts.delete(ip);
}

// ---------- Code instellen, openen, op slot ----------

export function weakCode(code) {
  const s = normCode(code);
  if (s.length < 8) return 'Kies een code van minstens 8 tekens.';
  if (s.length > 200) return 'Die code is te lang (maximaal 200 tekens).';
  if (/^\d+$/.test(s) && s.length < 12) return 'Alleen cijfers is makkelijk te raden. Gebruik ook letters, of minstens 12 cijfers.';
  // Eén los woord staat in elk woordenboek dat iemand zou proberen.
  if (/^\p{L}+$/u.test(s) && s.length < 16) return 'Eén woord is makkelijk te raden. Gebruik een paar woorden, of zet er cijfers of tekens tussen.';
  if (/^(.)\1+$/u.test(s) || /^(?:0123456789|1234567890|abcdefgh|qwertyui|password|wachtwoord)/i.test(s)) {
    return 'Die code is te makkelijk te raden.';
  }
  return null;
}

async function wrapKey(code, key) {
  const salt = crypto.randomBytes(16);
  const kek = await scrypt(code, salt, KDF);
  try {
    return { v: 1, kdf: KDF, salt: b64(salt), wrapped: b64(gcmEncrypt(kek, key, KEY_AAD)) };
  } finally {
    kek.fill(0);
  }
}

async function unwrapKey(code) {
  const rec = record();
  if (!rec) throw new LockedError(false);
  const kek = await scrypt(code, unb64(rec.salt), rec.kdf || KDF);
  try {
    return gcmDecrypt(kek, unb64(rec.wrapped), KEY_AAD);
  } catch {
    return null; // verkeerde code
  } finally {
    kek.fill(0);
  }
}

// Eerste keer: een nieuwe sleutel maken en die met de code afsluiten. Geeft een sessietoken terug.
export async function setup(code) {
  if (isSetup()) throw new Error('Er is al een code voor Privé');
  const problem = weakCode(code);
  if (problem) throw new Error(problem);
  const key = crypto.randomBytes(32);
  const rec = await wrapKey(code, key);
  if (isSetup()) {
    key.fill(0);
    throw new Error('Er is al een code voor Privé');
  }
  epoch++;
  store.setSetting('vault', { ...rec, created: Date.now() });
  if (dek) dek.fill(0);
  dek = key;
  return newSession();
}

// Geeft { ok, token } of { ok: false, wait }.
export async function unlock(ip, code) {
  if (!isSetup()) throw new LockedError(false);
  let wait = waitMinutes(ip);
  if (wait) return { ok: false, wait };
  // Eerst als fout tellen, zodat tegelijk raden niks oplevert.
  const mark = registerFail(ip);
  const started = epoch;
  const key = await unwrapKey(code);
  if (!key) {
    wait = waitMinutes(ip);
    return { ok: false, wait };
  }
  undoFail(ip, mark);
  if (started !== epoch || !isSetup()) {
    // Intussen is Privé gewist of opnieuw ingesteld: deze sleutel hoort nergens meer bij.
    key.fill(0);
    return { ok: false, wait: 0 };
  }
  if (dek) key.fill(0);
  else dek = key;
  return { ok: true, token: newSession() };
}

export async function changeCode(ip, oldCode, newCode) {
  const problem = weakCode(newCode);
  if (problem) throw new Error(problem);
  const wait = waitMinutes(ip);
  if (wait) throw new Error(`Te vaak een verkeerde code. Probeer het over ${wait} minuten opnieuw.`);
  const mark = registerFail(ip);
  const started = epoch;
  const key = await unwrapKey(oldCode);
  if (!key) throw new Error('Je huidige code klopt niet');
  undoFail(ip, mark);
  try {
    const rec = await wrapKey(newCode, key);
    if (started !== epoch || !isSetup()) throw new Error('Privé is intussen gewist');
    store.setSetting('vault', { ...rec, created: record()?.created || Date.now(), changed: Date.now() });
  } finally {
    key.fill(0);
  }
}

// Alles op slot, in elke browser.
export function lock() {
  wipe();
}

// Code vergeten: de kluis weggooien. Wat ermee versleuteld was, is daarna niet meer te lezen.
export function forget() {
  epoch++;
  wipe();
  store.setSetting('vault', null);
}

// ---------- Versleutelen ----------

// Tekst voor in de database. Lege tekst blijft leeg.
export function seal(text, aad) {
  if (text === null || text === undefined || text === '') return text;
  if (!dek) throw new LockedError(isSetup());
  return TEXT_PREFIX + b64(gcmEncrypt(dek, Buffer.from(String(text), 'utf8'), aad));
}

export function unseal(value, aad) {
  if (!isSealed(value)) return value; // (nog) niet versleuteld
  if (!dek) throw new LockedError(isSetup());
  return gcmDecrypt(dek, unb64(value.slice(TEXT_PREFIX.length)), aad).toString('utf8');
}

export const isSealed = (v) => typeof v === 'string' && v.startsWith(TEXT_PREFIX);

export function encryptBuffer(buf, aad) {
  if (!dek) throw new LockedError(isSetup());
  return gcmEncrypt(dek, buf, aad);
}

export function decryptBuffer(buf, aad) {
  if (!dek) throw new LockedError(isSetup());
  return gcmDecrypt(dek, buf, aad);
}
