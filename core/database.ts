import type Database from "better-sqlite3";

/** BB owns this database's lifecycle. Nested operations use SQLite savepoints. */
export class Store {
  constructor(readonly db: Database.Database) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
}
