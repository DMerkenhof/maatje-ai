// Inloggen met een wachtwoord.
//
//   AUTH=off          geen wachtwoord (alleen doen als de app niet vanaf internet bereikbaar is,
//                     bijvoorbeeld alleen via Tailscale)
//   APP_PASSWORD=...  je eigen wachtwoord
//   niks ingesteld    de app maakt bij de eerste start zelf een wachtwoord en zet dat in de logs
//
// Na het inloggen krijgt de browser een cookie die een half jaar geldig is.
// Verander je het wachtwoord, dan moet iedereen opnieuw inloggen.
import crypto from 'node:crypto';

export const COOKIE = 'maatje_sessie';
const MAX_AGE = 180 * 24 * 60 * 60; // seconden
const OFF = ['off', 'uit', 'false', '0', 'no', 'nee'];

let enabled = true;
let key = null;
let pwDigest = null;
const attempts = new Map(); // ip -> { fails, until }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function initAuth(store) {
  if (OFF.includes(String(process.env.AUTH || '').trim().toLowerCase())) {
    enabled = false;
    return { enabled, generated: null };
  }
  let password = String(process.env.APP_PASSWORD || '').trim();
  let generated = null;
  if (!password) {
    password = store.getSetting('generatedPassword', null);
    if (!password) {
      password = crypto.randomBytes(9).toString('base64url');
      store.setSetting('generatedPassword', password);
    }
    generated = password;
  }
  let secret = store.getSetting('authSecret', null);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    store.setSetting('authSecret', secret);
  }
  // Het wachtwoord zit in de sleutel, dus een nieuw wachtwoord maakt oude cookies ongeldig.
  key = crypto.createHmac('sha256', secret).update(password).digest();
  pwDigest = sha(password);
  return { enabled, generated };
}

export const authEnabled = () => enabled;

function sign(exp) {
  return b64(crypto.createHmac('sha256', key).update(String(exp)).digest());
}

export function makeSession() {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return { value: `${exp}.${sign(exp)}`, maxAge: MAX_AGE };
}

export function validSession(value) {
  if (!enabled) return true;
  if (typeof value !== 'string') return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Geeft { ok } of { ok: false, wait } terug. Na 5 foute pogingen een kwartier wachten.
// Daarnaast een rem voor iedereen samen (een IP-adres is makkelijk te vervalsen): 30 fouten per kwartier.
const global = { fails: [], until: 0 };

export function checkPassword(ip, password) {
  const now = Date.now();
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  if (a.until > now) return { ok: false, wait: Math.ceil((a.until - now) / 60000) };
  if (global.until > now) return { ok: false, wait: Math.ceil((global.until - now) / 60000) };
  const ok = crypto.timingSafeEqual(sha(password || ''), pwDigest);
  if (ok) {
    attempts.delete(ip);
    return { ok: true };
  }
  global.fails = global.fails.filter((t) => t > now - 15 * 60 * 1000);
  global.fails.push(now);
  if (global.fails.length >= 30) {
    global.fails = [];
    global.until = now + 15 * 60 * 1000;
  }
  a.fails += 1;
  if (a.fails >= 5) {
    a.fails = 0;
    a.until = now + 15 * 60 * 1000;
  }
  attempts.set(ip, a);
  return { ok: false, wait: a.until > now ? 15 : 0 };
}
