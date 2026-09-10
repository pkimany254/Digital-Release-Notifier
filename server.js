const express = require("express");
const axios = require("axios");
const Database = require("better-sqlite3");

// ============================================================
// BASIC SETUP
// ============================================================

const app = express();

const PORT = process.env.PORT || 7000;

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

// ============================================================
// SETTINGS
// ============================================================

const SETTINGS = {
  checkIntervalHours: 2,
  startupDelaySeconds: 15,

  tmdbLanguage: "en-US",
  timezone: "Africa/Nairobi",

  // Leave empty if you want worldwide digital-release discovery.
  // Use "KE" if you specifically want Kenya-region release dates.
  region: "",

  posterSize: "w500"
};

// ============================================================
// MOVIE FILTERS
// ============================================================

const MOVIE_FILTERS = {
  // How far back TMDB release dates are checked
  lookbackDays: 7,

  // Minimum TMDB popularity
  minPopularity: 2,

  // Original language(s)
  originalLanguages: ["en"],

  // Include only these genres.
  // [] = no specific include restriction
  includeGenres: [],

  // Exclude these genres
  // 16 = Animation
  excludeGenres: [16],

  // Require Digital release
  requireDigitalRelease: true,

  includeAdult: false,

  // Number of TMDB discover pages
  maxPages: 10
};

// ============================================================
// TV FILTERS
// ============================================================

const TV_FILTERS = {
  // Look for episodes/seasons released within this period
  episodeLookbackDays: 1,

  // Minimum TMDB popularity
  minPopularity: 10,

  // Original language(s)
  originalLanguages: ["en"],

  // Include only these genres
  includeGenres: [],

  // Excluded TV genres
  //
  // 16     Animation
  // 99     Documentary
  // 10763  News
  // 10764  Reality
  // 10766  Soap
  // 10767  Talk
  // 35     Comedy
  // 10751  Family
  //
  excludeGenres: [
    16,
    99,
    10763,
    10764,
    10766,
    10767,
    35,
    10751
  ],

  includeAdult: false,

  // Number of TMDB discover pages
  maxPages: 10,

  // Number of latest seasons inspected
  seasonsToInspect: 2
};

// ============================================================
// DATABASE
// ============================================================

const db = new Database("/data/watchlist.db");

db.pragma("journal_mode = WAL");

// Movies
db.prepare(`
  CREATE TABLE IF NOT EXISTS popular_movie_notifications (
    tmdb_id INTEGER PRIMARY KEY,
    notified_at TEXT NOT NULL
  )
`).run();

// Episodes
db.prepare(`
  CREATE TABLE IF NOT EXISTS popular_episode_notifications (
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    notified_at TEXT NOT NULL,
    PRIMARY KEY (tmdb_id, season, episode)
  )
`).run();

// NEW SERIES
db.prepare(`
  CREATE TABLE IF NOT EXISTS series_notifications (
    tmdb_id INTEGER PRIMARY KEY,
    notified_at TEXT NOT NULL
  )
`).run();

// NEW SEASON
db.prepare(`
  CREATE TABLE IF NOT EXISTS season_notifications (
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    notified_at TEXT NOT NULL,
    PRIMARY KEY (tmdb_id, season)
  )
`).run();

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function nowISO() {
  return new Date().toISOString();
}

function getPosterUrl(path) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}${path}`;
}

function matchesLanguage(item, languages) {
  if (!languages || languages.length === 0) {
    return true;
  }

  return languages.includes(item.original_language);
}

function matchesGenres(item, filters) {
  const genres = item.genre_ids || [];

  if (
    filters.includeGenres &&
    filters.includeGenres.length > 0
  ) {
    const hasIncludedGenre = filters.includeGenres.some(
      genreId => genres.includes(genreId)
    );

    if (!hasIncludedGenre) {
      return false;
    }
  }

  if (
    filters.excludeGenres &&
    filters.excludeGenres.length > 0
  ) {
    const hasExcludedGenre = filters.excludeGenres.some(
      genreId => genres.includes(genreId)
    );

    if (hasExcludedGenre) {
      return false;
    }
  }

  return true;
}

// ============================================================
// TMDB REQUEST
// ============================================================

async function tmdbGet(endpoint, params = {}) {
  try {
    const response = await axios.get(
      `${TMDB_BASE_URL}${endpoint}`,
      {
        params: {
          api_key: TMDB_API_KEY,
          ...params
        },
        timeout: 30000
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `TMDB error on ${endpoint}:`,
      error.response?.data || error.message
    );

    return null;
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegramMessage(text, posterUrl = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Telegram environment variables are missing.");
    return false;
  }

  try {
    if (posterUrl) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        {
          chat_id: TELEGRAM_CHAT_ID,
          photo: posterUrl,
          caption: text,
          parse_mode: "HTML"
        },
        {
          timeout: 30000
        }
      );
    } else {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML"
        },
        {
          timeout: 30000
        }
      );
    }

    return true;
  } catch (error) {
    console.error(
      "Telegram error:",
      error.response?.data || error.message
    );

    return false;
  }
}

// ============================================================
// REPEAT-PREVENTION CHECKS
// ============================================================

// ---------- MOVIE ----------

function movieAlreadyNotified(tmdbId) {
  const row = db
    .prepare(`
      SELECT tmdb_id
      FROM popular_movie_notifications
      WHERE tmdb_id = ?
    `)
    .get(tmdbId);

  return !!row;
}

function markMovieNotified(tmdbId) {
  db.prepare(`
    INSERT OR IGNORE INTO popular_movie_notifications
    (tmdb_id, notified_at)
    VALUES (?, ?)
  `).run(tmdbId, nowISO());
}

// ---------- SERIES ----------

function seriesAlreadyNotified(tmdbId) {
  const row = db
    .prepare(`
      SELECT tmdb_id
      FROM series_notifications
      WHERE tmdb_id = ?
    `)
    .get(tmdbId);

  return !!row;
}

function markSeriesNotified(tmdbId) {
  db.prepare(`
    INSERT OR IGNORE INTO series_notifications
    (tmdb_id, notified_at)
    VALUES (?, ?)
  `).run(tmdbId, nowISO());
}

// ---------- SEASON ----------

function seasonAlreadyNotified(tmdbId, seasonNumber) {
  const row = db
    .prepare(`
      SELECT tmdb_id
      FROM season_notifications
      WHERE tmdb_id = ?
      AND season = ?
    `)
    .get(tmdbId, seasonNumber);

  return !!row;
}

function markSeasonNotified(tmdbId, seasonNumber) {
  db.prepare(`
    INSERT OR IGNORE INTO season_notifications
    (tmdb_id, season, notified_at)
    VALUES (?, ?, ?)
  `).run(tmdbId, seasonNumber, nowISO());
}

// ---------- EPISODE ----------

function episodeAlreadyNotified(
  tmdbId,
  seasonNumber,
  episodeNumber
) {
  const row = db
    .prepare(`
      SELECT tmdb_id
      FROM popular_episode_notifications
      WHERE tmdb_id = ?
      AND season = ?
      AND episode = ?
    `)
    .get(
      tmdbId,
      seasonNumber,
      episodeNumber
    );

  return !!row;
}

function markEpisodeNotified(
  tmdbId,
  seasonNumber,
  episodeNumber
) {
  db.prepare(`
    INSERT OR IGNORE INTO popular_episode_notifications
    (tmdb_id, season, episode, notified_at)
    VALUES (?, ?, ?, ?)
  `).run(
    tmdbId,
    seasonNumber,
    episodeNumber,
    nowISO()
  );
}

// ============================================================
// MOVIES
// ============================================================

async function checkNewMovies() {
  console.log("\n================================");
  console.log("CHECKING NEW MOVIES");
  console.log("================================");

  const endDate = new Date();
  const startDate = daysAgo(MOVIE_FILTERS.lookbackDays);

  const gte = formatDate(startDate);
  const lte = formatDate(endDate);

  console.log(
    `Movie release window: ${gte} → ${lte}`
  );

  const candidates = [];

  for (
    let page = 1;
    page <= MOVIE_FILTERS.maxPages;
    page++
  ) {
    const params = {
      language: SETTINGS.tmdbLanguage,
      page,
      sort_by: "popularity.desc",
      "release_date.gte": gte,
      "release_date.lte": lte,
      with_release_type: 4,
      include_adult: MOVIE_FILTERS.includeAdult
    };

    if (SETTINGS.region) {
      params.region = SETTINGS.region;
    }

    const data = await tmdbGet(
      "/discover/movie",
      params
    );

    if (!data || !data.results) {
      break;
    }

    candidates.push(...data.results);

    if (
      !data.total_pages ||
      page >= data.total_pages
    ) {
      break;
    }

    await sleep(150);
  }

  console.log(
    `Movie candidates found: ${candidates.length}`
  );

  // Local filtering
  const filtered = candidates
    .filter(movie =>
      (movie.popularity || 0) >=
      MOVIE_FILTERS.minPopularity
    )
    .filter(movie =>
      matchesLanguage(
        movie,
        MOVIE_FILTERS.originalLanguages
      )
    )
    .filter(movie =>
      matchesGenres(movie, MOVIE_FILTERS)
    )
    .filter(movie =>
      !movie.adult || MOVIE_FILTERS.includeAdult
    )
    .sort(
      (a, b) =>
        (b.popularity || 0) -
        (a.popularity || 0)
    );

  console.log(
    `Movies remaining after filters: ${filtered.length}`
  );

  for (const movie of filtered) {
    if (movieAlreadyNotified(movie.id)) {
      continue;
    }

    const details = await tmdbGet(
      `/movie/${movie.id}/release_dates`
    );

    if (!details || !details.results) {
      continue;
    }

    let digitalRelease = null;

    for (const country of details.results) {
      const digital = (country.release_dates || [])
        .filter(release =>
          release.type === 4
        );

      for (const release of digital) {
        if (
          !digitalRelease ||
          new Date(release.release_date) >
            new Date(digitalRelease.release_date)
        ) {
          digitalRelease = {
            ...release,
            country: country.iso_3166_1
          };
        }
      }
    }

    if (
      MOVIE_FILTERS.requireDigitalRelease &&
      !digitalRelease
    ) {
      continue;
    }

    if (!digitalRelease) {
      continue;
    }

    const releaseDate = new Date(
      digitalRelease.release_date
    );

    if (
      releaseDate < startDate ||
      releaseDate > endDate
    ) {
      continue;
    }

    const year = movie.release_date
      ? movie.release_date.substring(0, 4)
      : "";

    const text =
      `🎬 <b>NEW MOVIE</b>\n\n` +
      `<b>${movie.title}</b>` +
      (year ? ` (${year})` : "") +
      `\n\n` +
      `⭐ Popularity: ${Number(
        movie.popularity || 0
      ).toFixed(1)}\n` +
      `📅 Release: ${movie.release_date || "Unknown"}\n` +
      `💻 Digital: ${formatDate(releaseDate)}`;

    const posterUrl = getPosterUrl(
      movie.poster_path
    );

    const sent = await sendTelegramMessage(
      text,
      posterUrl
    );

    // IMPORTANT:
    // Only save after Telegram successfully sends.
    if (sent) {
      markMovieNotified(movie.id);

      console.log(
        `NEW MOVIE notified: ${movie.title}`
      );
    }

    await sleep(500);
  }
}

// ============================================================
// TV SHOWS
// ============================================================

async function checkTVShows() {
  console.log("\n================================");
  console.log("CHECKING TV SHOWS");
  console.log("================================");

  const endDate = new Date();
  const startDate = daysAgo(
    TV_FILTERS.episodeLookbackDays
  );

  const gte = formatDate(startDate);
  const lte = formatDate(endDate);

  console.log(
    `TV window: ${gte} → ${lte}`
  );

  const candidates = [];

  for (
    let page = 1;
    page <= TV_FILTERS.maxPages;
    page++
  ) {
    const data = await tmdbGet(
      "/discover/tv",
      {
        language: SETTINGS.tmdbLanguage,
        page,
        sort_by: "popularity.desc",
        "air_date.gte": gte,
        "air_date.lte": lte,
        timezone: SETTINGS.timezone,
        include_adult: TV_FILTERS.includeAdult
      }
    );

    if (!data || !data.results) {
      break;
    }

    candidates.push(...data.results);

    if (
      !data.total_pages ||
      page >= data.total_pages
    ) {
      break;
    }

    await sleep(150);
  }

  console.log(
    `TV candidates found: ${candidates.length}`
  );

  const filtered = candidates
    .filter(show =>
      (show.popularity || 0) >=
      TV_FILTERS.minPopularity
    )
    .filter(show =>
      matchesLanguage(
        show,
        TV_FILTERS.originalLanguages
      )
    )
    .filter(show =>
      matchesGenres(show, TV_FILTERS)
    )
    .filter(show =>
      !show.adult || TV_FILTERS.includeAdult
    )
    .sort(
      (a, b) =>
        (b.popularity || 0) -
        (a.popularity || 0)
    );

  console.log(
    `TV shows remaining after filters: ${filtered.length}`
  );

  for (const show of filtered) {
    const details = await tmdbGet(
      `/tv/${show.id}`
    );

    if (!details) {
      continue;
    }

    await processTVShow(
      show,
      details,
      startDate,
      endDate
    );

    await sleep(400);
  }
}

// ============================================================
// PROCESS ONE TV SHOW
// ============================================================

async function processTVShow(
  show,
  details,
  startDate,
  endDate
) {
  if (!details.seasons) {
    return;
  }

  const seasons = details.seasons
    .filter(season =>
      season.season_number >= 0
    )
    .sort(
      (a, b) =>
        b.season_number -
        a.season_number
    )
    .slice(
      0,
      TV_FILTERS.seasonsToInspect
    );

  // ----------------------------------------------------------
  // CHECK SEASONS
  // ----------------------------------------------------------

  for (const season of seasons) {
    if (!season.air_date) {
      continue;
    }

    const seasonDate = new Date(
      `${season.air_date}T00:00:00`
    );

    if (
      seasonDate < startDate ||
      seasonDate > endDate
    ) {
      continue;
    }

    const seasonNumber =
      season.season_number;

    // Season 1 = NEW SERIES
    if (seasonNumber === 1) {
      if (!seriesAlreadyNotified(show.id)) {
        const text =
          `📺 <b>NEW SERIES</b>\n\n` +
          `<b>${details.name}</b>\n\n` +
          `⭐ Popularity: ${Number(
            show.popularity || 0
          ).toFixed(1)}\n` +
          `📅 First aired: ${details.first_air_date || "Unknown"}`;

        const posterUrl = getPosterUrl(
          details.poster_path ||
          show.poster_path
        );

        const sent =
          await sendTelegramMessage(
            text,
            posterUrl
          );

        if (sent) {
          markSeriesNotified(show.id);

          console.log(
            `NEW SERIES notified: ${details.name}`
          );
        }
      }
    }

    // Season 2+ = NEW SEASON
    else {
      if (
        !seasonAlreadyNotified(
          show.id,
          seasonNumber
        )
      ) {
        const text =
          `🔄 <b>NEW SEASON</b>\n\n` +
          `<b>${details.name}</b>\n` +
          `Season ${seasonNumber}\n\n` +
          `⭐ Popularity: ${Number(
            show.popularity || 0
          ).toFixed(1)}\n` +
          `📅 Season date: ${season.air_date}`;

        const posterUrl = getPosterUrl(
          details.poster_path ||
          show.poster_path
        );

        const sent =
          await sendTelegramMessage(
            text,
            posterUrl
          );

        if (sent) {
          markSeasonNotified(
            show.id,
            seasonNumber
          );

          console.log(
            `NEW SEASON notified: ${details.name} S${seasonNumber}`
          );
        }
      }
    }
  }

  // ----------------------------------------------------------
  // CHECK EPISODES
  // ----------------------------------------------------------

  for (const season of seasons) {
    const seasonNumber =
      season.season_number;

    if (seasonNumber < 1) {
      continue;
    }

    const seasonDetails =
      await tmdbGet(
        `/tv/${show.id}/season/${seasonNumber}`,
        {
          language: SETTINGS.tmdbLanguage
        }
      );

    if (
      !seasonDetails ||
      !seasonDetails.episodes
    ) {
      continue;
    }

    for (const episode of seasonDetails.episodes) {
      if (!episode.air_date) {
        continue;
      }

      const episodeDate = new Date(
        `${episode.air_date}T00:00:00`
      );

      if (
        episodeDate < startDate ||
        episodeDate > endDate
      ) {
        continue;
      }

      const episodeNumber =
        episode.episode_number;

      if (
        episodeAlreadyNotified(
          show.id,
          seasonNumber,
          episodeNumber
        )
      ) {
        continue;
      }

      const text =
        `▶️ <b>NEW EPISODE</b>\n\n` +
        `<b>${details.name}</b>\n` +
        `Season ${seasonNumber}, Episode ${episodeNumber}\n\n` +
        `${episode.name || "Untitled Episode"}\n\n` +
        `⭐ Popularity: ${Number(
          show.popularity || 0
        ).toFixed(1)}\n` +
        `📅 Air date: ${episode.air_date}`;

      const posterUrl = getPosterUrl(
        episode.still_path ||
        details.poster_path ||
        show.poster_path
      );

      const sent =
        await sendTelegramMessage(
          text,
          posterUrl
        );

      // Only mark after successful notification
      if (sent) {
        markEpisodeNotified(
          show.id,
          seasonNumber,
          episodeNumber
        );

        console.log(
          `NEW EPISODE notified: ${details.name} S${seasonNumber}E${episodeNumber}`
        );
      }

      await sleep(500);
    }
  }
}

// ============================================================
// RUN EVERYTHING
// ============================================================

let checkRunning = false;

async function runAllChecks() {
  if (checkRunning) {
    console.log(
      "A check is already running. Skipping."
    );
    return;
  }

  checkRunning = true;

  console.log("\n\n");
  console.log("============================================");
  console.log("STARTING FULL RELEASE CHECK");
  console.log("============================================");
  console.log(
    `Time: ${new Date().toISOString()}`
  );

  try {
    await checkNewMovies();
    await checkTVShows();

    console.log("\n============================================");
    console.log("FULL RELEASE CHECK COMPLETE");
    console.log("============================================\n");
  } catch (error) {
    console.error(
      "Full check error:",
      error
    );
  } finally {
    checkRunning = false;
  }
}

// ============================================================
// EXPRESS ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Movie & Series Release Notifier",
    version: "4.1.0",
    checkIntervalHours:
      SETTINGS.checkIntervalHours
  });
});

// Manually run everything
app.get("/run-all", async (req, res) => {
  if (checkRunning) {
    return res.json({
      status: "already_running"
    });
  }

  runAllChecks();

  res.json({
    status: "started"
  });
});

// Status
app.get("/status", (req, res) => {
  const movies =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM popular_movie_notifications
    `).get();

  const series =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM series_notifications
    `).get();

  const seasons =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM season_notifications
    `).get();

  const episodes =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM popular_episode_notifications
    `).get();

  res.json({
    status: "ok",

    repeatProtection: {
      moviesNotified: movies.count,
      seriesNotified: series.count,
      seasonsNotified: seasons.count,
      episodesNotified: episodes.count
    },

    checkIntervalHours:
      SETTINGS.checkIntervalHours,

    startupDelaySeconds:
      SETTINGS.startupDelaySeconds
  });
});

// Configuration
app.get("/config", (req, res) => {
  res.json({
    settings: SETTINGS,
    movieFilters: MOVIE_FILTERS,
    tvFilters: TV_FILTERS
  });
});

// ============================================================
// TEST MOVIE
// ============================================================

app.get("/test-movie/:tmdbId", async (req, res) => {
  const id = Number(req.params.tmdbId);

  if (!id) {
    return res.status(400).json({
      error: "Invalid TMDB ID"
    });
  }

  const movie = await tmdbGet(
    `/movie/${id}`,
    {
      language: SETTINGS.tmdbLanguage
    }
  );

  if (!movie) {
    return res.status(404).json({
      error: "Movie not found"
    });
  }

  const posterUrl = getPosterUrl(
    movie.poster_path
  );

  const text =
    `🎬 <b>TEST MOVIE</b>\n\n` +
    `<b>${movie.title}</b>\n\n` +
    `⭐ Popularity: ${Number(
      movie.popularity || 0
    ).toFixed(1)}`;

  const sent =
    await sendTelegramMessage(
      text,
      posterUrl
    );

  res.json({
    sent,
    movie
  });
});

// ============================================================
// TEST SHOW
// ============================================================

app.get("/test-show/:tmdbId", async (req, res) => {
  const id = Number(req.params.tmdbId);

  if (!id) {
    return res.status(400).json({
      error: "Invalid TMDB ID"
    });
  }

  const show = await tmdbGet(
    `/tv/${id}`,
    {
      language: SETTINGS.tmdbLanguage
    }
  );

  if (!show) {
    return res.status(404).json({
      error: "Show not found"
    });
  }

  const posterUrl = getPosterUrl(
    show.poster_path
  );

  const text =
    `📺 <b>TEST SERIES</b>\n\n` +
    `<b>${show.name}</b>\n\n` +
    `⭐ Popularity: ${Number(
      show.popularity || 0
    ).toFixed(1)}`;

  const sent =
    await sendTelegramMessage(
      text,
      posterUrl
    );

  res.json({
    sent,
    show
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `Automatic checks every ${SETTINGS.checkIntervalHours} hours`
  );

  console.log(
    `First check in ${SETTINGS.startupDelaySeconds} seconds`
  );

  setTimeout(() => {
    runAllChecks();
  }, SETTINGS.startupDelaySeconds * 1000);

  setInterval(
    () => {
      runAllChecks();
    },
    SETTINGS.checkIntervalHours *
      60 *
      60 *
      1000
  );
});
