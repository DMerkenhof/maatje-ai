// Opslag van gesprekken in één SQLite-bestand: /data/chats/chats.db
// Gebruikt de SQLite die in Node zit (node:sqlite), dus geen extra pakketten.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function openDb(dataDir) {
  const dir = path.join(dataDir, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'chats.db'));

  db.exec(`
    PRAGMA foreign_keys = ON;
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_memory ON messages(memory_status)`);

  // Antwoorden die nog liepen toen de container stopte, kunnen niet meer afkomen.
  db.prepare(`UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'`).run();

  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      listChats: db.prepare(`SELECT id, title, model, effort, created_at, updated_at FROM chats ORDER BY updated_at DESC`),
      getChat: db.prepare(`SELECT id, title, model, effort, created_at, updated_at FROM chats WHERE id = ?`),
      setChatEffort: db.prepare(`UPDATE chats SET effort = ? WHERE id = ?`),
      insertChat: db.prepare(`INSERT INTO chats (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`),
      renameChat: db.prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`),
      setChatModel: db.prepare(`UPDATE chats SET model = ? WHERE id = ?`),
      touchChat: db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`),
      deleteChat: db.prepare(`DELETE FROM chats WHERE id = ?`),
      listMessages: db.prepare(`SELECT id, role, content, model, status, error, usage, meta, memory_status, created_at FROM messages WHERE chat_id = ? ORDER BY id`),
      countMessages: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`),
      insertMessage: db.prepare(`INSERT INTO messages (chat_id, role, content, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      updateContent: db.prepare(`UPDATE messages SET content = ? WHERE id = ?`),
      finishMessage: db.prepare(`UPDATE messages SET content = ?, status = ?, error = ?, usage = ? WHERE id = ?`),
      getMessage: db.prepare(`SELECT id, role, content, model, status, error, usage, meta, memory_status, created_at FROM messages WHERE id = ?`),
      setMeta: db.prepare(`UPDATE messages SET meta = ? WHERE id = ?`),
      setMemoryStatus: db.prepare(`UPDATE messages SET memory_status = ? WHERE id = ?`),
      bumpMemoryAttempts: db.prepare(`UPDATE messages SET memory_attempts = memory_attempts + 1 WHERE id = ? RETURNING memory_attempts`),
      nextMemoryJob: db.prepare(`SELECT id, chat_id, content, created_at FROM messages WHERE memory_status = 'pending' ORDER BY id LIMIT 1`),
      countMemoryPending: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE memory_status = 'pending'`),
      messagesBefore: db.prepare(`SELECT id, role, content, status FROM messages WHERE chat_id = ? AND id < ? AND status != 'error' ORDER BY id DESC LIMIT ?`),
      deleteMessage: db.prepare(`DELETE FROM messages WHERE id = ? AND chat_id = ?`),
      getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
      setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    };
  }

  listChats() {
    return this.q.listChats.all();
  }

  getChat(id) {
    return this.q.getChat.get(id) || null;
  }

  createChat({ model = null } = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.q.insertChat.run(id, 'Nieuwe chat', model, now, now);
    return this.getChat(id);
  }

  renameChat(id, title) {
    this.q.renameChat.run(title, Date.now(), id);
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

  listMessages(chatId) {
    return this.q.listMessages.all(chatId).map(parseMessage);
  }

  countMessages(chatId) {
    return this.q.countMessages.get(chatId).n;
  }

  addMessage(chatId, { role, content = '', model = null, status = 'done' }) {
    const r = this.q.insertMessage.run(chatId, role, content, model, status, Date.now());
    return Number(r.lastInsertRowid);
  }

  updateContent(id, content) {
    this.q.updateContent.run(content, id);
  }

  finishMessage(id, { content, status, error = null, usage = null }) {
    this.q.finishMessage.run(content, status, error, usage ? JSON.stringify(usage) : null, id);
  }

  getMessage(id) {
    const m = this.q.getMessage.get(id);
    return m ? parseMessage(m) : null;
  }

  deleteMessage(chatId, id) {
    this.q.deleteMessage.run(id, chatId);
  }

  setMeta(id, meta) {
    this.q.setMeta.run(meta ? JSON.stringify(meta) : null, id);
  }

  setMemoryStatus(id, status) {
    this.q.setMemoryStatus.run(status, id);
  }

  bumpMemoryAttempts(id) {
    const r = this.q.bumpMemoryAttempts.get(id);
    return r ? r.memory_attempts : 0;
  }

  nextMemoryJob() {
    return this.q.nextMemoryJob.get() || null;
  }

  countMemoryPending() {
    return this.q.countMemoryPending.get().n;
  }

  // De berichten vóór een bepaald bericht, nieuwste eerst.
  messagesBefore(chatId, id, limit = 4) {
    return this.q.messagesBefore.all(chatId, id, limit);
  }

  getSetting(key, fallback = null) {
    const row = this.q.getSetting.get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  setSetting(key, value) {
    this.q.setSetting.run(key, JSON.stringify(value));
  }
}

function parseMessage(m) {
  const parse = (v) => {
    if (!v) return null;
    try { return JSON.parse(v); } catch { return null; }
  };
  return { ...m, usage: parse(m.usage), meta: parse(m.meta) };
}
