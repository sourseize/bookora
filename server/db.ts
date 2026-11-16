import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? "data/bookora.sqlite",
);
mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    time_zone TEXT NOT NULL DEFAULT 'UTC',
    locale TEXT NOT NULL DEFAULT 'en',
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at TEXT NOT NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'customer')),
    business_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (business_id) REFERENCES businesses(id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expiration ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS staff_invitations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_staff_invitations_business_id
    ON staff_invitations(business_id);
`);

const businessColumns = new Set(
  (db.pragma("table_info(businesses)") as Array<{ name: string }>).map(
    (column) => column.name,
  ),
);
if (!businessColumns.has("locale")) {
  db.exec("ALTER TABLE businesses ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'");
}
if (!businessColumns.has("currency")) {
  db.exec(
    "ALTER TABLE businesses ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'",
  );
}

db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    price_currency TEXT NOT NULL DEFAULT 'USD',
    buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
    category TEXT,
    online_booking INTEGER NOT NULL DEFAULT 1 CHECK (online_booking IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_services_business_active
    ON services(business_id, is_active, name);

  CREATE TABLE IF NOT EXISTS staff_services (
    business_id TEXT NOT NULL,
    staff_user_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (staff_user_id, service_id),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (staff_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_staff_services_service
    ON staff_services(service_id);
`);

const serviceColumns = new Set(
  (db.pragma("table_info(services)") as Array<{ name: string }>).map(
    (column) => column.name,
  ),
);
if (!serviceColumns.has("price_currency")) {
  db.exec(
    "ALTER TABLE services ADD COLUMN price_currency TEXT NOT NULL DEFAULT 'USD'",
  );
}
