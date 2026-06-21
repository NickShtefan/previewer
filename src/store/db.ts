import Database from "better-sqlite3";
import { migrate } from "./migrations";

/** Instance type of an open better-sqlite3 database. */
export type Db = Database.Database;

/** Injectable clock — real time in prod, controllable in tests. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Fixed-width ISO-8601 UTC string (lexicographically ordered == chronological). */
export const iso = (d: Date): string => d.toISOString();

/** Open (or create) the orchestrator DB, set pragmas, and ensure the schema. */
export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
