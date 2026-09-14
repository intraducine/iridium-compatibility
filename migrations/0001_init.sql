PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_app_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested', 'investigating', 'in-progress', 'testing', 'partial', 'compatible', 'blocked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  game_id INTEGER NOT NULL,
  voter_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, voter_hash),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quota_counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_votes_game_id ON votes(game_id);
CREATE INDEX IF NOT EXISTS idx_quota_created_at ON quota_counters(created_at);
