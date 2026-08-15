const express = require("express");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_API_KEY =
  process.env.TMDB_API_KEY;

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;

const SIMKL_CLIENT_ID =
  process.env.SIMKL_CLIENT_ID;

const SIMKL_CLIENT_SECRET =
  process.env.SIMKL_CLIENT_SECRET;

if (!TMDB_API_KEY) {
  console.warn(
    "WARNING: TMDB_API_KEY is not configured"
  );
}

app.use(express.json());

/* =========================================================
   DATABASE
========================================================= */

const db = new Database("/data/watchlist.db");

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

db.exec(`
  CREATE TABLE IF NOT EXISTS simkl_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    access_token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS simkl_movie_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    simkl_id INTEGER NOT NULL UNIQUE,
    tmdb_id INTEGER,
    title TEXT NOT NULL,
    notified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

/* =========================================================
   TMDB DIGITAL RELEASE CHECKER
========================================================= */

async function checkDigitalRelease(tmdbId) {
  if (!TMDB_API_KEY) {
    throw new Error(
      "TMDB_API_KEY is not configured"
    );
  }

  const url =
    `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?api_key=${TMDB_API_KEY}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `TMDB request failed: ${response.status}`
    );
  }

  const data =
    await response.json();

  const results =
    data.results || [];

  /*
   * Look through all countries.
   * TMDB release type 4 = Digital.
   */

  for (const country of results) {

    const releases =
      country.release_dates || [];

    const digital =
      releases.find(
        release =>
          release.type === 4
      );

    if (digital) {
      return {
        available: true,
        country: country.iso_3166_1,
        release_date:
          digital.release_date || null
      };
    }
  }

  return {
    available: false
  };
}

app.get(
  "/check/:tmdbId",
  async (req, res) => {

    const tmdbId =
      Number(req.params.tmdbId);

    if (!Number.isInteger(tmdbId)) {
      return res.status(400).json({
        error: "Invalid TMDB ID"
      });
    }

    try {

      const result =
        await checkDigitalRelease(
          tmdbId
        );

      res.json({
        tmdb_id: tmdbId,
        ...result
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Failed to check TMDB release"
      });
    }
  }
);

/* =========================================================
   TELEGRAM NOTIFICATION
========================================================= */

async function sendTelegramNotification(message) {

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    throw new Error(
      "Telegram configuration is missing"
    );
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    })
  });

  if (!response.ok) {
    throw new Error(
      `Telegram request failed: ${response.status}`
    );
  }

  return response.json();
}

/* =========================================================
   CHECK SIMKL MOVIE WATCHLIST
========================================================= */

async function checkSimklMovieWatchlist() {

  const data =
    await getSimklItems(
      "movies",
      "plantowatch"
    );

  const movies =
    data.movies || [];

  console.log(
    `Checking ${movies.length} Simkl movie(s)...`
  );

  let checked = 0;
  let released = 0;
  let skipped = 0;

  for (const item of movies) {

    const movie =
      item.movie;

    if (!movie) {
      skipped++;
      continue;
    }

    const tmdbId =
      movie.ids?.tmdb;

    if (!tmdbId) {

      console.log(
        `No TMDB ID for: ${movie.title}`
      );

      skipped++;
      continue;
    }

    try {

      checked++;

      const result =
        await checkDigitalRelease(
          Number(tmdbId)
        );

      if (!result.available) {

        console.log(
          `No digital release: ${movie.title}`
        );

        continue;
      }

      released++;

      console.log(
        `Digital release found: ${movie.title}`
      );

      /*
       * Check whether we have already
       * notified this movie.
       */

      const existing =
        db.prepare(`
          SELECT *
          FROM simkl_movie_notifications
          WHERE simkl_id = ?
        `).get(
          movie.ids?.simkl
        );

      if (existing) {

        console.log(
          `Already notified: ${movie.title}`
        );

        continue;
      }

      const message =
        `🔔 Digital Release Available\n\n` +
        `${movie.title}` +
        (
          movie.year
            ? ` (${movie.year})`
            : ""
        ) +
        `\n\n` +
        `A digital release is now available.` +
        (
          result.release_date
            ? `\nRelease date: ${result.release_date}`
            : ""
        );

      await sendTelegramNotification(
        message
      );

      db.prepare(`
        INSERT INTO simkl_movie_notifications (
          simkl_id,
          tmdb_id,
          title
        )
        VALUES (?, ?, ?)
      `).run(
        movie.ids?.simkl,
        Number(tmdbId),
        movie.title
      );

    } catch (error) {

      console.error(
        `Failed checking ${movie.title}:`,
        error.message
      );
    }
  }

  return {
    total: movies.length,
    checked,
    released,
    skipped
  };
}

app.post(
  "/simkl/check-movies",
  async (req, res) => {

    try {

      const result =
        await checkSimklMovieWatchlist();

      res.json({
        success: true,
        ...result
      });

    } catch (error) {

      console.error(
        "Simkl movie check error:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  "/simkl/check-movies",
  async (req, res) => {

    try {

      const result =
        await checkSimklMovieWatchlist();

      res.json({
        success: true,
        ...result
      });

    } catch (error) {

      console.error(
        "Simkl movie check error:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   CHECK WATCHLIST
========================================================= */

async function checkWatchlist() {

  const movies = db.prepare(`
    SELECT *
    FROM watchlist
    WHERE digital_available = 0
  `).all();

  console.log(
    `Checking ${movies.length} watchlist item(s)...`
  );

  for (const movie of movies) {

    try {

      const result =
        await checkDigitalRelease(
          movie.tmdb_id
        );

      if (result.available) {

        const message =
          `🔔 Digital Release Available\n\n` +
          `${movie.title}\n\n` +
          `Digital release detected by TMDB.` +
          (
            result.country
              ? `\nCountry: ${result.country}`
              : ""
          ) +
          (
            result.release_date
              ? `\nRelease date: ${result.release_date}`
              : ""
          );

        await sendTelegramNotification(
          message
        );

        db.prepare(`
          UPDATE watchlist
          SET
            digital_available = 1,
            notified = 1
          WHERE tmdb_id = ?
        `).run(movie.tmdb_id);

        console.log(
          `Digital release found and notification sent: ${movie.title}`
        );

      } else {

        console.log(
          `No digital release yet: ${movie.title}`
        );
      }

    } catch (error) {

      console.error(
        `Failed checking ${movie.title}:`,
        error.message
      );
    }
  }
}

app.post(
  "/check-watchlist",
  async (req, res) => {

    try {

      await checkWatchlist();

      res.json({
        success: true,
        message:
          "Watchlist check completed"
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Watchlist check failed"
      });
    }
  }
);

/* =========================================================
   SIMKL WATCHLIST
========================================================= */

async function getSimklItems(type, status) {

  const account = db.prepare(`
    SELECT access_token
    FROM simkl_accounts
    ORDER BY id DESC
    LIMIT 1
  `).get();

  if (!account) {
    throw new Error(
      "No Simkl account connected"
    );
  }

  const response = await fetch(
    `https://api.simkl.com/sync/all-items/${type}/${status}`,
    {
      method: "GET",

      headers: {
        "Content-Type": "application/json",
        "Authorization":
          `Bearer ${account.access_token}`,
        "simkl-api-key":
          SIMKL_CLIENT_ID
      }
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      `Simkl ${type}/${status} error:`,
      data
    );

    throw new Error(
      `Simkl API request failed: ${response.status}`
    );
  }

  return data;
}


/* =========================================================
   MOVIE WATCHLIST
========================================================= */

app.get(
  "/simkl/watchlist/movies",
  async (req, res) => {

    try {

      const data =
        await getSimklItems(
          "movies",
          "plantowatch"
        );

      const movies =
        data.movies || [];

      res.json({
        success: true,
        count: movies.length,
        items: movies
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);


/* =========================================================
   TV WATCHLIST
========================================================= */

app.get(
  "/simkl/watchlist/shows",
  async (req, res) => {

    try {

      const data =
        await getSimklItems(
          "tv",
          "plantowatch"
        );

      const shows =
  data.shows || [];

      res.json({
        success: true,
        count: shows.length,
        items: shows
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  "/simkl/test-show-release",
  async (req, res) => {

    try {

      const tmdbId = 108978;
      const seasonNumber = 4;
      const title = "Reacher";

      const url =
        `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`;

      const response =
        await fetch(url);

      if (!response.ok) {
        throw new Error(
          `TMDB request failed: ${response.status}`
        );
      }

      const data =
        await response.json();

      const episodes =
        data.episodes || [];

      const releasedEpisodes =
        episodes.filter(
          episode =>
            episode.air_date &&
            new Date(episode.air_date) <= new Date()
        );

      res.json({
        success: true,
        title,
        tmdb_id: tmdbId,
        season: seasonNumber,
        total_episodes: episodes.length,
        released_episodes: releasedEpisodes.length,
        episodes: releasedEpisodes.map(
          episode => ({
            episode: episode.episode_number,
            name: episode.name,
            air_date: episode.air_date
          })
        )
      });

    } catch (error) {

      console.error(
        "Show release test error:",
        error
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

/* =========================================================
   SIMKL OAUTH
========================================================= */

app.get("/auth/simkl", (req, res) => {

  const redirectUri =
    "https://digital-release-notifier-production.up.railway.app/auth/simkl/callback";

  const authUrl =
    "https://simkl.com/oauth/authorize" +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(SIMKL_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(authUrl);
});

app.get(
  "/auth/simkl/callback",
  async (req, res) => {

    const { code } = req.query;

    if (!code) {
      return res.status(400).send(
        "Simkl authorization code missing."
      );
    }

    try {

      const response = await fetch(
        "https://api.simkl.com/oauth/token",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            code,
            client_id: SIMKL_CLIENT_ID,
            client_secret: SIMKL_CLIENT_SECRET,
            redirect_uri:
              "https://digital-release-notifier-production.up.railway.app/auth/simkl/callback",
            grant_type:
              "authorization_code"
          })
        }
      );

      const data =
        await response.json();

      if (!response.ok) {

        console.error(
          "Simkl token error:",
          data
        );

        return res.status(500).send(
          "Failed to connect Simkl account."
        );
      }

      /* =====================================================
         SAVE SIMKL ACCESS TOKEN
      ===================================================== */

      if (!data.access_token) {

        return res.status(500).send(
          "Simkl did not provide an access token."
        );
      }

      /*
       * For now we keep one connected Simkl account.
       * Later, when we make this multi-user,
       * this table will store one account per user.
       */

      db.prepare(`
        DELETE FROM simkl_accounts
      `).run();

      db.prepare(`
        INSERT INTO simkl_accounts (
          access_token
        )
        VALUES (?)
      `).run(
        data.access_token
      );

      res.send(`
        <h2>Simkl account connected successfully! ✅</h2>
        <p>Your Simkl connection has been saved.</p>
      `);

    } catch (error) {

      console.error(error);

      res.status(500).send(
        "Simkl connection failed."
      );
    }
  }
);

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
      error:
        "tmdb_id and title are required"
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
        error:
          "Movie already exists in watchlist"
      });
    }

    console.error(error);

    res.status(500).json({
      error:
        "Failed to add movie"
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
        error:
          "Invalid TMDB ID"
      });
    }

    const result = db.prepare(`
      DELETE FROM watchlist
      WHERE tmdb_id = ?
    `).run(tmdbId);

    if (result.changes === 0) {

      return res.status(404).json({
        error:
          "Movie not found in watchlist"
      });
    }

    res.json({
      success: true,
      tmdb_id: tmdbId
    });

  }
);

/* =========================================================
   AUTOMATIC SIMKL MOVIE CHECK
========================================================= */

setInterval(
  async () => {

    try {

      console.log(
        "Running automatic Simkl movie check..."
      );

      const result =
        await checkSimklMovieWatchlist();

      console.log(
        "Automatic movie check completed:",
        result
      );

    } catch (error) {

      console.error(
        "Automatic Simkl movie check failed:",
        error
      );
    }

  },
  6 * 60 * 60 * 1000
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {

  console.log(
    `Watchlist notifier running on port ${PORT}`
  );

});
