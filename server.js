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

app.use(express.json());

/* =========================================================
   CONFIGURATION
========================================================= */

const CHECK_INTERVAL =
  6 * 60 * 60 * 1000;

const STARTUP_DELAY =
  15 * 1000;

/*
 * Number of TMDB pages to scan.
 * One page normally contains 20 results.
 */
const MOVIE_PAGES = 2;
const TV_PAGES = 2;

/*
 * Maximum number of unique movies/shows to inspect.
 */
const MAX_MOVIES = 30;
const MAX_SHOWS = 30;

/*
 * Only notify for TV episodes that aired recently.
 * Duplicate protection is handled by the database.
 */
const EPISODE_LOOKBACK_DAYS = 7;

if (!TMDB_API_KEY) {
  console.warn(
    "WARNING: TMDB_API_KEY is not configured"
  );
}

if (
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHAT_ID
) {
  console.warn(
    "WARNING: Telegram configuration is incomplete"
  );
}

/* =========================================================
   DATABASE
========================================================= */

const db =
  new Database("/data/watchlist.db");

db.pragma("journal_mode = WAL");

/*
 * Movies already notified about.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS popular_movie_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    release_date TEXT,
    notified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

/*
 * TV episodes already notified about.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS popular_episode_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    title TEXT NOT NULL,
    air_date TEXT,
    notified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tmdb_id, season, episode)
  )
`);

/* =========================================================
   TMDB HELPER
========================================================= */

async function tmdb(path) {

  if (!TMDB_API_KEY) {
    throw new Error(
      "TMDB_API_KEY is not configured"
    );
  }

  const separator =
    path.includes("?")
      ? "&"
      : "?";

  const url =
    `https://api.themoviedb.org/3${path}` +
    `${separator}api_key=${encodeURIComponent(TMDB_API_KEY)}`;

  const response =
    await fetch(url);

  if (!response.ok) {

    const body =
      await response.text();

    throw new Error(
      `TMDB request failed: ${response.status} ${body}`
    );
  }

  return response.json();
}

/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegramNotification(
  message
) {

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

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        chat_id:
          TELEGRAM_CHAT_ID,
        text:
          message
      })
    });

  if (!response.ok) {

    const body =
      await response.text();

    throw new Error(
      `Telegram request failed: ${response.status} ${body}`
    );
  }

  return response.json();
}

/* =========================================================
   GET POPULAR + TRENDING MOVIES
========================================================= */

async function getPopularMovies() {

  const movies =
    new Map();

  /*
   * Popular movies.
   */

  for (
    let page = 1;
    page <= MOVIE_PAGES;
    page++
  ) {

    const data =
      await tmdb(
        `/movie/popular?page=${page}`
      );

    for (
      const movie of data.results || []
    ) {

      if (movie.id) {

        movies.set(
          movie.id,
          movie
        );
      }
    }
  }

  /*
   * Weekly trending movies.
   */

  const trending =
    await tmdb(
      "/trending/movie/week"
    );

  for (
    const movie of trending.results || []
  ) {

    if (movie.id) {

      movies.set(
        movie.id,
        movie
      );
    }
  }

  /*
   * Sort by popularity and keep the top candidates.
   */

  return Array.from(
    movies.values()
  )
    .sort(
      (a, b) =>
        (b.popularity || 0) -
        (a.popularity || 0)
    )
    .slice(
      0,
      MAX_MOVIES
    );
}

/* =========================================================
   CHECK MOVIE DIGITAL RELEASE
========================================================= */

async function getDigitalRelease(
  tmdbId
) {

  const data =
    await tmdb(
      `/movie/${tmdbId}/release_dates`
    );

  const now =
    new Date();

  const candidates =
    [];

  for (
    const country of data.results || []
  ) {

    for (
      const release
        of country.release_dates || []
    ) {

      /*
       * TMDB release type 4 = Digital.
       */

      if (
        release.type !== 4 ||
        !release.release_date
      ) {
        continue;
      }

      const releaseDate =
        new Date(
          release.release_date
        );

      /*
       * Ignore future digital releases.
       */

      if (
        releaseDate <= now
      ) {

        candidates.push({
          country:
            country.iso_3166_1,

          release_date:
            release.release_date
        });
      }
    }
  }

  if (
    !candidates.length
  ) {

    return {
      available: false
    };
  }

  candidates.sort(
    (a, b) =>
      new Date(a.release_date) -
      new Date(b.release_date)
  );

  return {
    available: true,

    country:
      candidates[0].country,

    release_date:
      candidates[0].release_date
  };
}

/* =========================================================
   CHECK POPULAR MOVIES
========================================================= */

async function checkPopularMovies() {

  const movies =
    await getPopularMovies();

  let checked = 0;
  let released = 0;
  let notified = 0;
  let alreadyNotified = 0;
  let errors = 0;

  console.log(
    `Checking ${movies.length} popular/trending movie(s)...`
  );

  for (
    const movie of movies
  ) {

    try {

      checked++;

      const release =
        await getDigitalRelease(
          movie.id
        );

      if (
        !release.available
      ) {

        console.log(
          `No digital release: ${movie.title}`
        );

        continue;
      }

      released++;

      const existing =
        db.prepare(`
          SELECT id
          FROM popular_movie_notifications
          WHERE tmdb_id = ?
        `).get(
          movie.id
        );

      if (existing) {

        alreadyNotified++;

        console.log(
          `Already notified: ${movie.title}`
        );

        continue;
      }

      const year =
        movie.release_date
          ? movie.release_date.slice(
              0,
              4
            )
          : "";

      const message =
        `🔔 New Digital Release\n\n` +
        `🎬 ${movie.title}` +
        (
          year
            ? ` (${year})`
            : ""
        ) +
        `\n\n` +
        `Digital release available.` +
        `\nRelease date: ${release.release_date}`;

      await sendTelegramNotification(
        message
      );

      db.prepare(`
        INSERT INTO popular_movie_notifications (
          tmdb_id,
          title,
          release_date
        )
        VALUES (?, ?, ?)
      `).run(
        movie.id,
        movie.title,
        release.release_date
      );

      notified++;

      console.log(
        `NOTIFIED movie: ${movie.title}`
      );

    } catch (error) {

      errors++;

      console.error(
        `Movie check failed for ${movie.title}:`,
        error.message
      );
    }
  }

  return {
    total:
      movies.length,

    checked,

    released,

    notified,

    already_notified:
      alreadyNotified,

    errors
  };
}

/* =========================================================
   GET POPULAR + TRENDING TV SHOWS
========================================================= */

async function getPopularShows() {

  const shows =
    new Map();

  /*
   * Popular TV shows.
   */

  for (
    let page = 1;
    page <= TV_PAGES;
    page++
  ) {

    const data =
      await tmdb(
        `/tv/popular?page=${page}`
      );

    for (
      const show of data.results || []
    ) {

      if (show.id) {

        shows.set(
          show.id,
          show
        );
      }
    }
  }

  /*
   * Weekly trending TV shows.
   */

  const trending =
    await tmdb(
      "/trending/tv/week"
    );

  for (
    const show of trending.results || []
  ) {

    if (show.id) {

      shows.set(
        show.id,
        show
      );
    }
  }

  return Array.from(
    shows.values()
  )
    .sort(
      (a, b) =>
        (b.popularity || 0) -
        (a.popularity || 0)
    )
    .slice(
      0,
      MAX_SHOWS
    );
}

/* =========================================================
   CHECK POPULAR TV SHOW EPISODES
========================================================= */

async function checkPopularShows() {

  const shows =
    await getPopularShows();

  let checked = 0;
  let available = 0;
  let notified = 0;
  let alreadyNotified = 0;
  let errors = 0;

  const cutoff =
    new Date();

  cutoff.setDate(
    cutoff.getDate() -
    EPISODE_LOOKBACK_DAYS
  );

  console.log(
    `Checking ${shows.length} popular/trending TV show(s)...`
  );

  for (
    const show of shows
  ) {

    try {

      checked++;

      /*
       * Get full show details so we can identify
       * the latest season.
       */

      const details =
        await tmdb(
          `/tv/${show.id}`
        );

      const seasons =
        (details.seasons || [])
          .filter(
            season =>
              season.season_number >= 0
          );

      if (
        !seasons.length
      ) {
        continue;
      }

      const latestSeason =
        seasons.reduce(
          (latest, season) =>
            season.season_number >
            latest.season_number
              ? season
              : latest
        );

      const seasonNumber =
        latestSeason.season_number;

      const seasonData =
        await tmdb(
          `/tv/${show.id}/season/${seasonNumber}`
        );

      const episodes =
        seasonData.episodes || [];

      /*
       * Only consider episodes released within
       * the last 7 days.
       */

      const newEpisodes =
        episodes.filter(
          episode => {

            if (
              !episode.air_date
            ) {
              return false;
            }

            const airDate =
              new Date(
                episode.air_date
              );

            return (
              airDate <= new Date() &&
              airDate >= cutoff
            );
          }
        );

      if (
        !newEpisodes.length
      ) {
        continue;
      }

      available +=
        newEpisodes.length;

      /*
       * Notify every new episode once.
       */

      for (
        const episode
          of newEpisodes
      ) {

        const existing =
          db.prepare(`
            SELECT id
            FROM popular_episode_notifications
            WHERE tmdb_id = ?
              AND season = ?
              AND episode = ?
          `).get(
            show.id,
            seasonNumber,
            episode.episode_number
          );

        if (existing) {

          alreadyNotified++;

          continue;
        }

        const episodeCode =
          `S${String(
            seasonNumber
          ).padStart(2, "0")}` +
          `E${String(
            episode.episode_number
          ).padStart(2, "0")}`;

        const message =
          `📺 New Episode Available\n\n` +
          `${show.name}\n` +
          `${episodeCode} — ${episode.name}` +
          `\n\n` +
          `Release date: ${episode.air_date}`;

        await sendTelegramNotification(
          message
        );

        db.prepare(`
          INSERT INTO popular_episode_notifications (
            tmdb_id,
            season,
            episode,
            title,
            air_date
          )
          VALUES (?, ?, ?, ?, ?)
        `).run(
          show.id,
          seasonNumber,
          episode.episode_number,
          show.name,
          episode.air_date
        );

        notified++;

        console.log(
          `NOTIFIED episode: ${show.name} ${episodeCode}`
        );
      }

    } catch (error) {

      errors++;

      console.error(
        `TV check failed for ${show.name}:`,
        error.message
      );
    }
  }

  return {
    total:
      shows.length,

    checked,

    available,

    notified,

    already_notified:
      alreadyNotified,

    errors
  };
}

/* =========================================================
   RUN EVERYTHING
========================================================= */

let checkInProgress =
  false;

let lastCheck = {
  started_at:
    null,

  finished_at:
    null,

  movies:
    null,

  shows:
    null,

  error:
    null
};

async function runAllChecks() {

  if (
    checkInProgress
  ) {

    console.log(
      "A check is already running. Skipping."
    );

    return {
      success:
        false,

      skipped:
        true,

      reason:
        "check_in_progress"
    };
  }

  checkInProgress =
    true;

  lastCheck = {
    started_at:
      new Date().toISOString(),

    finished_at:
      null,

    movies:
      null,

    shows:
      null,

    error:
      null
  };

  try {

    console.log(
      "========================================"
    );

    console.log(
      "RUNNING POPULAR RELEASE CHECK"
    );

    console.log(
      "========================================"
    );

    const movies =
      await checkPopularMovies();

    lastCheck.movies =
      movies;

    console.log(
      "Movie check completed:",
      movies
    );

    const shows =
      await checkPopularShows();

    lastCheck.shows =
      shows;

    console.log(
      "TV check completed:",
      shows
    );

    lastCheck.finished_at =
      new Date().toISOString();

    return {
      success:
        true,

      movies,

      shows
    };

  } catch (error) {

    lastCheck.error =
      error.message;

    lastCheck.finished_at =
      new Date().toISOString();

    console.error(
      "Release check failed:",
      error
    );

    return {
      success:
        false,

      error:
        error.message,

      movies:
        lastCheck.movies,

      shows:
        lastCheck.shows
    };

  } finally {

    checkInProgress =
      false;
  }
}

/* =========================================================
   MANUAL CHECK
========================================================= */

app.get(
  "/run-all",
  async (req, res) => {

    const result =
      await runAllChecks();

    res.json(
      result
    );
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/status",
  (req, res) => {

    res.json({
      success:
        true,

      check_in_progress:
        checkInProgress,

      last_check:
        lastCheck
    });
  }
);

/* =========================================================
   TEST MOVIE
========================================================= */

app.get(
  "/test-movie/:tmdbId",
  async (req, res) => {

    const tmdbId =
      Number(
        req.params.tmdbId
      );

    if (
      !Number.isInteger(
        tmdbId
      )
    ) {

      return res.status(400).json({
        error:
          "Invalid TMDB ID"
      });
    }

    try {

      const movie =
        await tmdb(
          `/movie/${tmdbId}`
        );

      const release =
        await getDigitalRelease(
          tmdbId
        );

      res.json({
        success:
          true,

        movie: {
          tmdb_id:
            movie.id,

          title:
            movie.title,

          release_date:
            movie.release_date
        },

        digital_release:
          release
      });

    } catch (error) {

      console.error(
        error
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   TEST TV SHOW
========================================================= */

app.get(
  "/test-show/:tmdbId",
  async (req, res) => {

    const tmdbId =
      Number(
        req.params.tmdbId
      );

    if (
      !Number.isInteger(
        tmdbId
      )
    ) {

      return res.status(400).json({
        error:
          "Invalid TMDB ID"
      });
    }

    try {

      const details =
        await tmdb(
          `/tv/${tmdbId}`
        );

      const seasons =
        (details.seasons || [])
          .filter(
            season =>
              season.season_number >= 0
          );

      if (
        !seasons.length
      ) {

        return res.json({
          success:
            true,

          title:
            details.name,

          episodes:
            []
        });
      }

      const latestSeason =
        seasons.reduce(
          (latest, season) =>
            season.season_number >
            latest.season_number
              ? season
              : latest
        );

      const seasonData =
        await tmdb(
          `/tv/${tmdbId}/season/${latestSeason.season_number}`
        );

      const cutoff =
        new Date();

      cutoff.setDate(
        cutoff.getDate() -
        EPISODE_LOOKBACK_DAYS
      );

      const episodes =
        (seasonData.episodes || [])
          .filter(
            episode =>
              episode.air_date &&
              new Date(
                episode.air_date
              ) <= new Date() &&
              new Date(
                episode.air_date
              ) >= cutoff
          )
          .map(
            episode => ({
              episode:
                episode.episode_number,

              name:
                episode.name,

              air_date:
                episode.air_date
            })
          );

      res.json({
        success:
          true,

        title:
          details.name,

        tmdb_id:
          tmdbId,

        season:
          latestSeason.season_number,

        recent_released_episodes:
          episodes
      });

    } catch (error) {

      console.error(
        error
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({
      status:
        "ok",

      service:
        "movie-series-release-notifier",

      version:
        "2.0.0",

      monitoring:
        "TMDB popular and trending"
    });
  }
);

/* =========================================================
   AUTOMATIC 6-HOUR CHECK
========================================================= */

setInterval(
  async () => {

    await runAllChecks();

  },
  CHECK_INTERVAL
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Movie & Series Release Notifier running on port ${PORT}`
    );

    /*
     * Run one check shortly after startup.
     */
    setTimeout(
      async () => {

        console.log(
          "Running initial release check..."
        );

        await runAllChecks();

      },
      STARTUP_DELAY
    );
  }
);
