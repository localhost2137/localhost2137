PRAGMA user_version = 0;

CREATE TABLE legacy_users (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	is_admin INTEGER NOT NULL,
	created_at_ms INTEGER NOT NULL
);

INSERT INTO legacy_users(id, name, is_admin, created_at_ms)
VALUES ('U000001', 'Legacy Ada', 1, 1767225600000);
