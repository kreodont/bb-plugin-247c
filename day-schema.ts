export const DAY_SCHEMA = [
  `CREATE TABLE day_items (id TEXT PRIMARY KEY, date TEXT NOT NULL, reported_date TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), calendar_key TEXT UNIQUE, value_json TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX day_task_unique ON day_items(date,task_id) WHERE task_id IS NOT NULL`,
  `CREATE INDEX day_items_date ON day_items(date,reported_date)`,
  `CREATE TABLE day_configs (date TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
  `CREATE TABLE day_item_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES day_items(id), at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL)`,
  `CREATE INDEX day_item_history ON day_item_events(item_id,sequence)`,
  `CREATE TABLE day_config_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL)`,
  `CREATE TABLE calendar_sync_state (id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL)`,
];
