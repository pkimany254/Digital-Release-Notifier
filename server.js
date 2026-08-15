const express = require("express");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================================================
   DATABASE
========================================================= */

const db = new Database("watchlist.db");

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    poster TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    digital_available INTEGER NOT NULL DEFAULT 0,
    notified INTEGER NOT NULL DEFAULT 0
  )
`);


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "watchlist-notifier",
    version: "0.1.0"
  });
});


/* =========================================================
   ADD TO WATCHLIST
========================================================= */

app.post("/watchlist", (req, res) => {
  const {
    tmdb_id,
    title,
    poster
  } = req.body;

  if (!tmdb_id || !title) {
    return res.status(400).json({
      error: "tmdb_id and title are required"
    });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO watchlist (
        tmdb_id,
        title,
        poster
      )
      VALUES (?, ?, ?)
    `);

    const result = stmt.run(
      tmdb_id,
      title,
      poster || null
    );

    res.status(201).json({
      success: true,
      id: result.lastInsertRowid,
      tmdb_id,
      title,
      poster: poster || null
    });

  } catch (error) {

    if (
      error.code ===
      "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      return res.status(409).json({
        error: "Movie already exists in watchlist"
      });
    }

    console.error(error);

    res.status(500).json({
      error: "Failed to add movie"
    });
  }
});


/* =========================================================
   GET WATCHLIST
========================================================= */

app.get("/watchlist", (req, res) => {

  const rows = db.prepare(`
    SELECT *
    FROM watchlist
    ORDER BY added_at DESC
  `).all();

  res.json({
    count: rows.length,
    items: rows
  });
});


/* =========================================================
   REMOVE FROM WATCHLIST
========================================================= */

app.delete(
  "/watchlist/:tmdbId",
  (req, res) => {

    const tmdbId =
      Number(req.params.tmdbId);

    if (!Number.isInteger(tmdbId)) {
      return res.status(400).json({
        error: "Invalid TMDB ID"
      });
    }

    const result = db.prepare(`
      DELETE FROM watchlist
      WHERE tmdb_id = ?
    `).run(tmdbId);

    if (result.changes === 0) {
      return res.status(404).json({
        error: "Movie not found in watchlist"
      });
    }

    res.json({
      success: true,
      tmdb_id: tmdbId
    });
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
  console.log(
    `Watchlist notifier running on port ${PORT}`
  );
});
