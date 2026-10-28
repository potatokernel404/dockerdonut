import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const databasePath = process.env.DB_PATH ?? "./data/app.db";

if (databasePath !== ":memory:") {
  mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
}

export const database = new Database(databasePath);

database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tests (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    duration_minutes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('single', 'multiple', 'written')),
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL,
    correct_answers_json TEXT NOT NULL,
    points INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'graded', 'expired')),
    answers_json TEXT,
    score INTEGER,
    max_score INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tests_section ON tests(section_id);
  CREATE INDEX IF NOT EXISTS idx_questions_test ON questions(test_id, position);
  CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id, submitted_at);
`);

export async function seedAdmin(): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!username && !password) return;
  if (!username || !password) {
    throw new Error("Set both ADMIN_USERNAME and ADMIN_PASSWORD to seed an admin account.");
  }
  if (username.length < 3 || username.length > 32 || password.length < 8) {
    throw new Error("Admin username must be 3-32 characters and password at least 8 characters.");
  }

  const existingUser = database
    .prepare("SELECT id, role FROM users WHERE username = ?")
    .get(username) as { id: string; role: string } | undefined;

  if (existingUser?.role === "admin") return;
  if (existingUser) {
    throw new Error("ADMIN_USERNAME is already registered as a student. Choose another admin username.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  database
    .prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(randomUUID(), username, passwordHash);
}
