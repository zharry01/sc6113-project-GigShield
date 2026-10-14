// Persistent storage: SQLite via Node's built-in node:sqlite (Node >= 22.13, no native build needed)
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "gigshield.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- On-chain events indexed from all four contracts
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contract      TEXT    NOT NULL,   -- GigShield address (deployment the event belongs to)
    source        TEXT    NOT NULL,   -- GigShield | RoleRegistry | GUSDToken | RiskPool
    name          TEXT    NOT NULL,
    args          TEXT    NOT NULL,   -- JSON
    actor         TEXT,               -- main address involved (lower-case)
    block_number  INTEGER NOT NULL,
    tx_hash       TEXT    NOT NULL,
    log_index     INTEGER NOT NULL,
    timestamp     INTEGER NOT NULL,
    UNIQUE (tx_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract, block_number);
  CREATE INDEX IF NOT EXISTS idx_events_name ON events (contract, name);

  -- Transactions submitted from the dApp (with gas estimate vs. actual)
  CREATE TABLE IF NOT EXISTS transactions (
    hash          TEXT PRIMARY KEY,
    contract      TEXT NOT NULL,
    from_address  TEXT NOT NULL,
    action        TEXT NOT NULL,
    gas_estimate  TEXT,
    gas_used      TEXT,
    gas_price     TEXT,
    status        TEXT NOT NULL,      -- success | failed
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions (contract, from_address);

  -- Off-chain claim evidence; only keccak256(text) is stored on-chain
  CREATE TABLE IF NOT EXISTS evidence (
    hash        TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    submitter   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

export function getMeta(key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}
