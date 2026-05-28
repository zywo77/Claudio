const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'state.db');

let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat','cron','webhook')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      song_id TEXT NOT NULL,
      song_name TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      played_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      date TEXT NOT NULL,
      plan_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, date)
    );

    CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  return db;
}

// --- messages ---

function appendMessage(userId, role, content, source = 'chat') {
  const stmt = db.prepare(
    'INSERT INTO messages (user_id, role, content, source) VALUES (?, ?, ?, ?)'
  );
  return stmt.run(userId, role, content, source);
}

function recentMessages(limit = 10, userId = 'default') {
  const stmt = db.prepare(
    'SELECT role, content, source, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  );
  return stmt.all(userId, limit).reverse();
}

// --- plays ---

function appendPlay(userId, songId, songName = '', artist = '') {
  const stmt = db.prepare(
    'INSERT INTO plays (user_id, song_id, song_name, artist) VALUES (?, ?, ?, ?)'
  );
  return stmt.run(userId, songId, songName, artist);
}

function recentPlays(limit = 30, userId = 'default') {
  const stmt = db.prepare(
    'SELECT song_id, song_name, artist, played_at FROM plays WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  );
  return stmt.all(userId, limit);
}

// --- combined recent query (matches README: state.recent({ messages:10, plays:30 })) ---

function recent({ messages = 10, plays = 30, userId = 'default' } = {}) {
  return {
    messages: recentMessages(messages, userId),
    plays: recentPlays(plays, userId),
  };
}

// --- plan ---

function getPlan(date, userId = 'default') {
  const stmt = db.prepare('SELECT plan_json FROM plan WHERE user_id = ? AND date = ?');
  const row = stmt.get(userId, date);
  return row ? JSON.parse(row.plan_json) : null;
}

function setPlan(date, planObj, userId = 'default') {
  const stmt = db.prepare(`
    INSERT INTO plan (user_id, date, plan_json) VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET plan_json = excluded.plan_json, created_at = datetime('now','localtime')
  `);
  return stmt.run(userId, date, JSON.stringify(planObj));
}

// --- prefs ---

function getPref(key) {
  const stmt = db.prepare('SELECT value FROM prefs WHERE key = ?');
  const row = stmt.get(key);
  return row ? row.value : null;
}

function setPref(key, value) {
  const stmt = db.prepare(`
    INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')
  `);
  return stmt.run(key, String(value));
}

// --- user notes (persistent memory) ---

function saveUserNote(text) {
  const existing = getPref('user_notes');
  const notes = existing ? JSON.parse(existing) : [];
  notes.push({ text, at: new Date().toISOString() });
  // 保留最近 50 条
  if (notes.length > 50) notes.splice(0, notes.length - 50);
  setPref('user_notes', JSON.stringify(notes));
}

function getUserNotes() {
  const raw = getPref('user_notes');
  return raw ? JSON.parse(raw) : [];
}

// --- close ---

function close() {
  if (db) db.close();
}

module.exports = { init, appendMessage, recentMessages, appendPlay, recentPlays, recent, getPlan, setPlan, getPref, setPref, saveUserNote, getUserNotes, close };
