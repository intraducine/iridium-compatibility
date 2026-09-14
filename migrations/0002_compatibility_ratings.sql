PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS compatibility_ratings (
  game_id INTEGER NOT NULL,
  voter_hash TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  iridium_version TEXT NOT NULL DEFAULT '' CHECK(length(iridium_version) <= 40),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 600),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, voter_hash),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_compatibility_ratings_game_id
  ON compatibility_ratings(game_id);
CREATE INDEX IF NOT EXISTS idx_compatibility_ratings_updated_at
  ON compatibility_ratings(updated_at DESC);
