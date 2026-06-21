import { openDatabase, type Db } from "./db";
import { SqliteStore } from "./sqlite-store";
import { SqliteQueue, type SqliteQueueOptions } from "./sqlite-queue";

export * from "./db";
export * from "./migrations";
export * from "./sqlite-store";
export * from "./sqlite-queue";

export interface Stores {
  db: Db;
  store: SqliteStore;
  queue: SqliteQueue;
}

/** Open one DB and wire a Store + Queue that share the connection. */
export function createStores(dbPath: string, opts: SqliteQueueOptions = {}): Stores {
  const db = openDatabase(dbPath);
  const store = new SqliteStore(db, opts.clock);
  const queue = new SqliteQueue(db, opts);
  return { db, store, queue };
}
