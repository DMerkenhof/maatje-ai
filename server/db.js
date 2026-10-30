// Opslag van gesprekken in één SQLite-bestand: /data/chats/chats.db
// Gebruikt de SQLite die in Node zit (node:sqlite), dus geen extra pakketten.
//
// Van privéchats staan de titel, de berichten en de extra info versleuteld in de database
// (zie vault.js). Zonder je code is daar niks van te lezen.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as vault from './vault.js';

export function openDb(dataDir) {
  const dir = path.join(dataDir, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'chats.db'));

  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'Nieuwe chat',
      model       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      model       TEXT,
      status      TEXT NOT NULL DEFAULT 'done',
      error       TEXT,
      usage       TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Nieuwe kolommen voor bestaande databases (memory-wachtrij en extra info per bericht).
  const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  if (!cols.includes('memory_status')) db.exec(`ALTER TABLE messages ADD COLUMN memory_status TEXT`);
  if (!cols.includes('memory_attempts')) db.exec(`ALTER TABLE messages ADD COLUMN memory_attempts INTEGER NOT NULL DEFAULT 0`);
  if (!cols.includes('meta')) db.exec(`ALTER TABLE messages ADD COLUMN meta TEXT`);
  const chatCols = db.prepare(`PRAGMA table_info(chats)`).all().map((c) => c.name);
  if (!chatCols.includes('effort')) db.exec(`ALTER TABLE chats ADD COLUMN effort TEXT`);
  // Privéchats gebruiken de privé-memory (zie memory.js).
  if (!chatCols.includes('private')) db.exec(`ALTER TABLE chats ADD COLUMN private INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_memory ON messages(memory_status)`);
  // Voorstellen voor de privé-memory die wachten tot je ze goedkeurt (versleuteld).
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_proposals (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      data        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_chat ON memory_proposals(chat_id, created_at);
  `);

  // Antwoorden die nog liepen toen de container stopte, kunnen niet meer afkomen.
  db.prepare(`UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'`).run();

  return new Store(db);
}

const aadFor = (chatId) => `chat:${chatId}`;

class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      listChats: db.prepare(`SELECT id, title, model, effort, private, created_at, updated_at FROM chats ORDER BY updated_at DESC`),
      getChat: db.prepare(`SELECT id, title, model, effort, private, created_at, updated_at FROM chats WHERE id = ?`),
      chatPrivate: db.prepare(`SELECT private FROM chats WHERE id = ?`),
      messageChat: db.prepare(`SELECT m.chat_id AS chat_id, c.private AS private FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?`),
      setChatEffort: db.prepare(`UPDATE chats SET effort = ? WHERE id = ?`),
      insertChat: db.prepare(`INSERT INTO chats (id, title, model, private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`),
      renameChat: db.prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`),
      setChatModel: db.prepare(`UPDATE chats SET model = ? WHERE id = ?`),
      touchChat: db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`),
      deleteChat: db.prepare(`DELETE FROM chats WHERE id = ?`),
      listMessages: db.prepare(`SELECT id, role, content, model, status, error, usage, meta, memory_status, created_at FROM messages WHERE chat_id = ? ORDER BY id`),
      countMessages: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`),
      insertMessage: db.prepare(`INSERT INTO messages (chat_id, role, content, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      updateContent: db.prepare(`UPDATE messages SET content = ? WHERE id = ?`),
      finishMessage: db.prepare(`UPDATE messages SET content = ?, status = ?, error = ?, usage = ? WHERE id = ?`),
      setStatus: db.prepare(`UPDATE messages SET status = ? WHERE id = ?`),
      getMessage: db.prepare(`SELECT id, role, content, model, status, error, usage, meta, memory_status, created_at FROM messages WHERE id = ?`),
      setMeta: db.prepare(`UPDATE messages SET meta = ? WHERE id = ?`),
      setMemoryStatus: db.prepare(`UPDATE messages SET memory_status = ? WHERE id = ?`),
      bumpMemoryAttempts: db.prepare(`UPDATE messages SET memory_attempts = memory_attempts + 1 WHERE id = ? RETURNING memory_attempts`),
      nextMemoryJob: db.prepare(`
        SELECT m.id AS id, m.chat_id AS chat_id, m.content AS content, m.created_at AS created_at, c.private AS private
        FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.memory_status = 'pending' AND (c.private = 0 OR ? = 1)
        ORDER BY m.id LIMIT 1`),
      countMemoryPending: db.prepare(`
        SELECT COUNT(*) AS n FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.memory_status = 'pending' AND c.private = ?`),
      chatMemoryPending: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND memory_status = 'pending'`),
      messagesBefore: db.prepare(`SELECT id, role, content, status FROM messages WHERE chat_id = ? AND id < ? AND status != 'error' ORDER BY id DESC LIMIT ?`),
      deleteMessage: db.prepare(`DELETE FROM messages WHERE id = ? AND chat_id = ?`),
      getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
      setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      addProposal: db.prepare(`INSERT INTO memory_proposals (id, chat_id, message_id, created_at, data) VALUES (?, ?, ?, ?, ?)`),
      listProposals: db.prepare(`SELECT id, chat_id, message_id, created_at, data FROM memory_proposals WHERE chat_id = ? ORDER BY created_at`),
      getProposal: db.prepare(`SELECT id, chat_id, message_id, created_at, data FROM memory_proposals WHERE id = ?`),
      deleteProposal: db.prepare(`DELETE FROM memory_proposals WHERE id = ?`),
      countProposals: db.prepare(`SELECT COUNT(*) AS n FROM memory_proposals`),
    };
  }

  // ---------- Versleutelen van privéchats ----------

  isPrivateChat(chatId) {
    return Boolean(this.q.chatPrivate.get(chatId)?.private);
  }

  // Versleutelt een waarde als de chat privé is.
  sealFor(chatId, priv, text) {
    return priv ? vault.seal(text, aadFor(chatId)) : text;
  }

  openFor(chatId, priv, value) {
    return priv ? vault.unseal(value, aadFor(chatId)) : value;
  }

  readChat(c) {
    if (!c) return null;
    const out = { ...c, private: Boolean(c.private) };
    if (out.private) {
      try {
        out.title = vault.unseal(c.title, aadFor(c.id));
      } catch (err) {
        if (!err.locked) throw err;
        out.title = null;
        out.locked = true;
      }
    }
    return out;
  }

  readMessage(m, chatId, priv) {
    if (!m) return null;
    const parse = (v) => {
      if (!v) return null;
      try { return JSON.parse(v); } catch { return null; }
    };
    return {
      ...m,
      content: this.openFor(chatId, priv, m.content),
      error: this.openFor(chatId, priv, m.error),
      usage: parse(m.usage),
      meta: parse(this.openFor(chatId, priv, m.meta)),
    };
  }

  // Na het instellen of openen van de kluis: oude, onversleutelde privéchats alsnog versleutelen.
  sealLegacyPrivate() {
    const chats = this.db.prepare(`SELECT id, title FROM chats WHERE private = 1`).all();
    const getMsgs = this.db.prepare(`SELECT id, content, error, meta FROM messages WHERE chat_id = ?`);
    const updMsg = this.db.prepare(`UPDATE messages SET content = ?, error = ?, meta = ? WHERE id = ?`);
    const updTitle = this.db.prepare(`UPDATE chats SET title = ? WHERE id = ?`);
    const fix = (chatId, v) => (v && !vault.isSealed(v) ? vault.seal(v, aadFor(chatId)) : v);
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const c of chats) {
        if (c.title && !vault.isSealed(c.title)) {
          updTitle.run(fix(c.id, c.title), c.id);
          changed++;
        }
        for (const m of getMsgs.all(c.id)) {
          const next = [fix(c.id, m.content), fix(c.id, m.error), fix(c.id, m.meta)];
          if (next[0] !== m.content || next[1] !== m.error || next[2] !== m.meta) {
            updMsg.run(next[0] ?? '', next[1] ?? null, next[2] ?? null, m.id);
            changed++;
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // Oude, onversleutelde stukken ook uit de vrije ruimte van het bestand halen.
    if (changed) this.db.exec('VACUUM');
    return changed;
  }

  // Code vergeten: alle privéchats weg.
  deleteAllPrivate() {
    this.db.prepare(`DELETE FROM chats WHERE private = 1`).run();
    this.db.exec('VACUUM');
  }

  // ---------- Chats ----------

  listChats({ includePrivate = false } = {}) {
    const out = [];
    for (const row of this.q.listChats.all()) {
      if (row.private && !includePrivate) continue;
      const c = this.readChat(row);
      if (c.locked) continue;
      out.push(c);
    }
    return out;
  }

  getChat(id) {
    return this.readChat(this.q.getChat.get(id));
  }

  createChat({ model = null, private: isPrivate = false } = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.q.insertChat.run(id, this.sealFor(id, isPrivate, 'Nieuwe chat'), model, isPrivate ? 1 : 0, now, now);
    return this.getChat(id);
  }

  renameChat(id, title) {
    this.q.renameChat.run(this.sealFor(id, this.isPrivateChat(id), title), Date.now(), id);
  }

  setChatModel(id, model) {
    this.q.setChatModel.run(model, id);
  }

  setChatEffort(id, effort) {
    this.q.setChatEffort.run(effort || null, id);
  }

  touchChat(id) {
    this.q.touchChat.run(Date.now(), id);
  }

  deleteChat(id) {
    this.q.deleteChat.run(id);
  }

  // ---------- Berichten ----------

  listMessages(chatId) {
    const priv = this.isPrivateChat(chatId);
    return this.q.listMessages.all(chatId).map((m) => this.readMessage(m, chatId, priv));
  }

  countMessages(chatId) {
    return this.q.countMessages.get(chatId).n;
  }

  addMessage(chatId, { role, content = '', model = null, status = 'done' }) {
    const sealed = this.sealFor(chatId, this.isPrivateChat(chatId), content) ?? '';
    const r = this.q.insertMessage.run(chatId, role, sealed, model, status, Date.now());
    return Number(r.lastInsertRowid);
  }

  where(id) {
    const r = this.q.messageChat.get(id);
    return r ? { chatId: r.chat_id, priv: Boolean(r.private) } : { chatId: null, priv: false };
  }

  updateContent(id, content) {
    const { chatId, priv } = this.where(id);
    this.q.updateContent.run(this.sealFor(chatId, priv, content) ?? '', id);
  }

  finishMessage(id, { content, status, error = null, usage = null }) {
    const { chatId, priv } = this.where(id);
    this.q.finishMessage.run(
      this.sealFor(chatId, priv, content) ?? '',
      status,
      this.sealFor(chatId, priv, error) ?? null,
      usage ? JSON.stringify(usage) : null,
      id
    );
  }

  // Alleen de status (bijv. als Privé op slot ging terwijl er nog een antwoord liep).
  setStatus(id, status) {
    this.q.setStatus.run(status, id);
  }

  getMessage(id) {
    const m = this.q.getMessage.get(id);
    if (!m) return null;
    const { chatId, priv } = this.where(id);
    return this.readMessage(m, chatId, priv);
  }

  deleteMessage(chatId, id) {
    this.q.deleteMessage.run(id, chatId);
  }

  setMeta(id, meta) {
    const { chatId, priv } = this.where(id);
    this.q.setMeta.run(meta ? this.sealFor(chatId, priv, JSON.stringify(meta)) : null, id);
  }

  // ---------- Memory-wachtrij ----------

  setMemoryStatus(id, status) {
    this.q.setMemoryStatus.run(status, id);
  }

  bumpMemoryAttempts(id) {
    const r = this.q.bumpMemoryAttempts.get(id);
    return r ? r.memory_attempts : 0;
  }

  // Privé-klussen alleen als de kluis open is.
  nextMemoryJob({ includePrivate = false } = {}) {
    const j = this.q.nextMemoryJob.get(includePrivate ? 1 : 0);
    if (!j) return null;
    const priv = Boolean(j.private);
    return { ...j, private: priv, content: this.openFor(j.chat_id, priv, j.content) };
  }

  countMemoryPending(space = 'work') {
    return this.q.countMemoryPending.get(space === 'private' ? 1 : 0).n;
  }

  chatMemoryPending(chatId) {
    return this.q.chatMemoryPending.get(chatId).n;
  }

  // De berichten vóór een bepaald bericht, nieuwste eerst.
  messagesBefore(chatId, id, limit = 4) {
    const priv = this.isPrivateChat(chatId);
    return this.q.messagesBefore.all(chatId, id, limit).map((m) => ({ ...m, content: this.openFor(chatId, priv, m.content) }));
  }

  // ---------- Voorstellen voor de privé-memory ----------

  addProposal(chatId, messageId, items) {
    const id = crypto.randomUUID();
    this.q.addProposal.run(id, chatId, messageId, Date.now(), vault.seal(JSON.stringify({ items }), `proposal:${chatId}:${id}`));
    return id;
  }

  readProposal(row) {
    if (!row) return null;
    const data = JSON.parse(vault.unseal(row.data, `proposal:${row.chat_id}:${row.id}`));
    return { id: row.id, chatId: row.chat_id, messageId: row.message_id, created: row.created_at, items: data.items || [] };
  }

  listProposals(chatId) {
    return this.q.listProposals.all(chatId).map((r) => this.readProposal(r));
  }

  getProposal(id) {
    return this.readProposal(this.q.getProposal.get(id));
  }

  deleteProposal(id) {
    this.q.deleteProposal.run(id);
  }

  countProposals() {
    return this.q.countProposals.get().n;
  }

  // ---------- Instellingen ----------

  getSetting(key, fallback = null) {
    const row = this.q.getSetting.get(key);
    if (!row) return fallback;
    try {
      const v = JSON.parse(row.value);
      return v === null ? fallback : v;
    } catch { return fallback; }
  }

  setSetting(key, value) {
    this.q.setSetting.run(key, JSON.stringify(value));
  }
}
