PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY NOT NULL,
  nickname TEXT,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  rating INTEGER NOT NULL DEFAULT 1000,
  tier TEXT NOT NULL DEFAULT 'Bronze',
  match_count INTEGER NOT NULL DEFAULT 0,
  win_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS score_records (
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  song TEXT NOT NULL,
  diff TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'precision')),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 1000000),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  absolute_sync INTEGER NOT NULL DEFAULT 0 CHECK (absolute_sync >= 0),
  tp_perfect INTEGER NOT NULL DEFAULT 0 CHECK (tp_perfect >= 0),
  perfect INTEGER NOT NULL DEFAULT 0 CHECK (perfect >= 0),
  good INTEGER NOT NULL DEFAULT 0 CHECK (good >= 0),
  bad INTEGER NOT NULL DEFAULT 0 CHECK (bad >= 0),
  miss INTEGER NOT NULL DEFAULT 0 CHECK (miss >= 0),
  total_notes INTEGER NOT NULL CHECK (total_notes > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, song, diff),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_score_records_ranking
  ON score_records (song, diff, score DESC, updated_at ASC);
