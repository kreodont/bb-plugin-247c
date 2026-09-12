// Append after every existing migration; storage indexes are permanent.
export const AGENT_TIME_SCHEMA = [
  `CREATE TABLE agent_time_state (id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL)`,
  `CREATE TABLE agent_time_threads (thread_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), after_seq INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE agent_time_events (thread_id TEXT NOT NULL REFERENCES agent_time_threads(thread_id), seq INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(thread_id,seq))`,
];
