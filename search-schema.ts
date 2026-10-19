// Derived data only. Append migrations; never change released statements.
export const SEARCH_MIGRATION = `
CREATE TABLE search_documents (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
  kind TEXT NOT NULL, label TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  at TEXT, thread_id TEXT, sequence INTEGER, session_id TEXT
);
CREATE INDEX search_document_task ON search_documents(task_id,kind);
CREATE INDEX search_document_thread ON search_documents(thread_id);
CREATE VIRTUAL TABLE search_fts USING fts5(title,body,content='search_documents',content_rowid='id',tokenize='unicode61');
CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_fts(rowid,title,body) VALUES(new.id,new.title,new.body);
END;
CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_fts(search_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
END;
CREATE TRIGGER search_document_update AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_fts(search_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
  INSERT INTO search_fts(rowid,title,body) VALUES(new.id,new.title,new.body);
END;
CREATE TABLE search_dirty (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE search_threads (
  thread_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
  max_seq INTEGER NOT NULL DEFAULT 0, cursor_json TEXT, target_seq INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT, error TEXT
);
INSERT INTO search_dirty SELECT 'task',id FROM tasks;
INSERT INTO search_dirty SELECT 'transcript',session_id FROM session_transcripts;
CREATE TRIGGER search_task_insert AFTER INSERT ON tasks BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',new.id); END;
CREATE TRIGGER search_task_update AFTER UPDATE ON tasks BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',new.id); END;
CREATE TRIGGER search_task_delete AFTER DELETE ON tasks BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',old.id); END;
CREATE TRIGGER search_projection_insert AFTER INSERT ON task_projections BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',new.task_id); END;
CREATE TRIGGER search_projection_update AFTER UPDATE ON task_projections BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',new.task_id); END;
CREATE TRIGGER search_fact_insert AFTER INSERT ON task_facts BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',new.task_id); END;
CREATE TRIGGER search_fact_update AFTER UPDATE ON task_facts BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',new.task_id); END;
CREATE TRIGGER search_fact_delete AFTER DELETE ON task_facts BEGIN INSERT OR IGNORE INTO search_dirty VALUES('task',old.task_id); END;
CREATE TRIGGER search_transcript_insert AFTER INSERT ON session_transcripts BEGIN INSERT OR IGNORE INTO search_dirty VALUES('transcript',new.session_id); END;
`;
