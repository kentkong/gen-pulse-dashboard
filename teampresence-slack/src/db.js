import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDb(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence (
      user_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      note TEXT,
      until_ts INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rollcalls (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_ts TEXT
    );

    CREATE TABLE IF NOT EXISTS rollcall_responses (
      rollcall_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      answered_at INTEGER NOT NULL,
      PRIMARY KEY (rollcall_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS checkins (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, date)
    );
  `);
  return db;
}

export function upsertPresence(db, { userId, state, note, untilTs }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO presence (user_id, state, note, until_ts, updated_at)
     VALUES (@userId, @state, @note, @untilTs, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       state = excluded.state,
       note = excluded.note,
       until_ts = excluded.until_ts,
       updated_at = excluded.updated_at`
  ).run({ userId, state, note: note ?? null, untilTs: untilTs ?? null, now });
}

export function getPresence(db, userId) {
  return db
    .prepare(`SELECT * FROM presence WHERE user_id = ?`)
    .get(userId);
}

export function createRollcall(db, { id, channelId, title, createdBy, messageTs }) {
  db.prepare(
    `INSERT INTO rollcalls (id, channel_id, title, created_by, created_at, message_ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, channelId, title, createdBy, Date.now(), messageTs ?? null);
}

export function setRollcallMessageTs(db, id, messageTs) {
  db.prepare(`UPDATE rollcalls SET message_ts = ? WHERE id = ?`).run(messageTs, id);
}

export function recordRollcallResponse(db, { rollcallId, userId, status }) {
  db.prepare(
    `INSERT INTO rollcall_responses (rollcall_id, user_id, status, answered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(rollcall_id, user_id) DO UPDATE SET
       status = excluded.status,
       answered_at = excluded.answered_at`
  ).run(rollcallId, userId, status, Date.now());
}

export function getRollcall(db, id) {
  return db.prepare(`SELECT * FROM rollcalls WHERE id = ?`).get(id);
}

export function listRollcallResponses(db, rollcallId) {
  return db
    .prepare(
      `SELECT user_id AS userId, status, answered_at AS answeredAt
       FROM rollcall_responses WHERE rollcall_id = ?`
    )
    .all(rollcallId);
}

export function upsertCheckin(db, { userId, date, state, note }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO checkins (user_id, date, state, note, updated_at)
     VALUES (@userId, @date, @state, @note, @now)
     ON CONFLICT(user_id, date) DO UPDATE SET
       state = excluded.state,
       note = excluded.note,
       updated_at = excluded.updated_at`
  ).run({ userId, date, state, note: note ?? null, now });
}

export function listCheckinsForDate(db, date) {
  return db
    .prepare(
      `SELECT user_id AS userId, date, state, note, updated_at AS updatedAt
       FROM checkins WHERE date = ?`
    )
    .all(date);
}

export function listRecentPresence(db, sinceTs) {
  return db
    .prepare(
      `SELECT user_id AS userId, state, note, until_ts AS untilTs, updated_at AS updatedAt
       FROM presence WHERE updated_at >= ?
       ORDER BY updated_at DESC`
    )
    .all(sinceTs);
}

export function listRecentRollcalls(db, limit = 10) {
  return db
    .prepare(
      `SELECT id, channel_id AS channelId, title, created_by AS createdBy,
              created_at AS createdAt, message_ts AS messageTs
       FROM rollcalls
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function listAllKnownUserIds(db, sinceTs) {
  const rows = db
    .prepare(
      `SELECT user_id AS userId FROM presence WHERE updated_at >= ?
       UNION
       SELECT user_id AS userId FROM checkins WHERE updated_at >= ?`
    )
    .all(sinceTs, sinceTs);
  return rows.map((r) => r.userId);
}
