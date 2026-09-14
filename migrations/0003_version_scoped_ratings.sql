PRAGMA foreign_keys = OFF;

CREATE TABLE compatibility_ratings_v2 (
  game_id INTEGER NOT NULL,
  voter_hash TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  iridium_version TEXT NOT NULL CHECK(length(iridium_version) BETWEEN 1 AND 40),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 600),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, voter_hash, iridium_version),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

INSERT INTO compatibility_ratings_v2
  (game_id, voter_hash, rating, iridium_version, notes, created_at, updated_at)
SELECT
  game_id,
  voter_hash,
  rating,
  CASE
    WHEN trim(iridium_version) = '' THEN 'legacy'
    ELSE substr(trim(iridium_version), 1, 40)
  END,
  notes,
  created_at,
  updated_at
FROM compatibility_ratings;

DROP TABLE compatibility_ratings;
ALTER TABLE compatibility_ratings_v2 RENAME TO compatibility_ratings;

CREATE INDEX idx_compatibility_ratings_game_id
  ON compatibility_ratings(game_id);
CREATE INDEX idx_compatibility_ratings_version
  ON compatibility_ratings(game_id, iridium_version);
CREATE INDEX idx_compatibility_ratings_updated_at
  ON compatibility_ratings(updated_at DESC);

PRAGMA foreign_keys = ON;
