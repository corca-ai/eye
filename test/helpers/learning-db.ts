import { DatabaseSync } from 'node:sqlite';
import { IncrementalLearning, type LearningSQL } from '../../src/runtime/incremental.js';

export function learningDatabase() {
  const db = new DatabaseSync(':memory:');
  const sql: LearningSQL = {
    exec<T extends Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]) {
      let rows: T[];
      if (query.trimStart().startsWith('CREATE ')) { db.exec(query); rows = []; }
      else rows = db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  const engine = new IncrementalLearning(sql);
  return { engine, close: () => db.close() };
}
