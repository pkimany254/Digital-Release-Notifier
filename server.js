// ============================================================
// MOVIE + TV RELEASE NOTIFIER
// Version 4.0.0
//
// MOVIES:
// Recent releases -> Digital release -> Popularity -> Filters
// -> NEW MOVIE notification
//
// TV:
// Recent episode/season activity -> Popularity -> Filters
// -> NEW SERIES or NEW SEASON notification
//
// All movie/TV notifications include a TMDB poster.
// ============================================================

const express = require("express");
const Database = require("better-sqlite3");

// ============================================================
// ===================== EDIT SETTINGS HERE ===================
// ============================================================

const SETTINGS = {
  // Automatic check interval
  checkIntervalHours: 6,

  // Wait after Railway/server startup before first check
  startupDelaySeconds: 15,

  // TMDB language used for returned metadata
  tmdbLanguage: "en-US",

  // Timezone used for date calculations
  timezone: "Africa/Nairobi",

  // TMDB region. Leave empty if you want worldwide release data.
  // Kenya = KE
  region: "KE",

  // Telegram poster size
  posterSize: "w500"
};


// ============================================================
// ======================= MOVIE FILTERS ======================
// ============================================================

const MOVIE_FILTERS = {

  // How many days back TMDB releases should be considered.
  //
  // 7 means a movie can become popular during the week
  // instead of having to be popular on the exact release day.
  lookbackDays: 7,

  // Minimum TMDB popularity required.
  //
  // Example:
  // 0  = everything
  // 5  = fairly low threshold
  // 10 = moderate threshold
  // 20 = more selective
  minPopularity: 10,

  // Only use these original languages.
  //
  // [] = all languages
  // ["en"] = English-language movies
  // ["en", "ko"] = English + Korean
  originalLanguages: ["en"],

  // Genre IDs that MUST be present.
  //
  // [] = don't require any particular genre
  includeGenres: [],

  // Genre IDs to exclude.
  //
  // 16 = Animation
  excludeGenres: [
    16
  ],

  // Digital release is required.
  requireDigitalRelease: true,

  // Adult content
  includeAdult: false,

  // Maximum pages to inspect from TMDB Discover.
  //
  // 5 pages ~= up to 100 results.
  // 10 pages ~= up to 200 results.
  maxPages: 10
};


// ============================================================
// ======================== TV FILTERS ========================
// ============================================================

const TV_FILTERS = {

  // Look for TV activity during the last X days.
  episodeLookbackDays: 7,

  // Minimum popularity required.
  minPopularity: 10,

  // [] = all languages
  // ["en"] = English-language series
  originalLanguages: ["en"],

  // Require these genres if not empty.
  includeGenres: [],

  // Genres to exclude.
  //
  // 16 = Animation
  // 99 = Documentary
  // 10763 = News
  // 10764 = Reality
  // 10766 = Soap
  // 10767 = Talk
  // 35 = Comedy
  // 10751 = Family
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

  // Maximum pages from Discover TV.
  maxPages: 10,

  // Number of recent seasons to inspect when identifying
  // a NEW SEASON.
  seasonsToInspect: 5
};


// ============================================================
// ====================== TELEGRAM SETTINGS ===================
// ============================================================

const TELEGRAM_SETTINGS = {
  // Poster size:
  // w342, w500, w780
  posterSize: "w500"
};


// ============================================================
// ===================== ENVIRONMENT ===========================
// ============================================================

const PORT = process.env.PORT || 7000;

const TMDB_API_KEY = process.env.TMDB_API_KEY;

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;


// ============================================================
// ======================== VALIDATION =========================
// ============================================================

if (!TMDB_API_KEY) {
  console.warn("⚠️ TMDB_API_KEY is not configured.");
}

if (!TELEGRAM_BOT_TOKEN) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN is not configured.");
}

if (!TELEGRAM_CHAT_ID) {
  console.warn("⚠️ TELEGRAM_CHAT_ID is not configured.");
}


// ============================================================
// ========================== APP ==============================
// ============================================================

const app = express();

app.use(express.json());


// ============================================================
// ========================= DATABASE ==========================
// ============================================================

const db = new Database("/data/watchlist.db");

db.pragma("journal_mode = WAL");


// ------------------------------------------------------------
// Movie notifications
// ------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS popular_movie_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL UNIQUE,
    title TEXT,
    release_date TEXT,
    digital_date TEXT,
    popularity REAL,
    notified_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);


// ------------------------------------------------------------
// TV episode notifications
// ------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS popular_episode_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    show_name TEXT,
    episode_name TEXT,
    air_date TEXT,
    notification_type TEXT,
    notified_at TEXT DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(tmdb_id, season, episode)
  )
`);


// ------------------------------------------------------------
// TV season notifications
// ------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS tv_season_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    show_name TEXT,
    season_name TEXT,
    air_date TEXT,
    popularity REAL,
    notified_at TEXT DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(tmdb_id, season)
  )
`);


// ============================================================
// ======================== HELPERS ============================
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function formatDate(date) {
  return date.toISOString().slice(0, 10);
}


function daysAgo(days) {
  const date = new Date();

  date.setUTCDate(date.getUTCDate() - days);

  return formatDate(date);
}


function today() {
  return formatDate(new Date());
}


function uniqueArray(array) {
  return [...new Set(array)];
}


function joinParams(params) {
  return new URLSearchParams(params).toString();
}


// ============================================================
// ========================= TMDB API ==========================
// ============================================================

async function tmdb(endpoint, params = {}) {

  const query = new URLSearchParams({
    api_key: TMDB_API_KEY,
    language: SETTINGS.tmdbLanguage,
    ...params
  });

  const url =
    `https://api.themoviedb.org/3${endpoint}?${query.toString()}`;

  const response = await fetch(url);

  if (!response.ok) {

    const text = await response.text();

    throw new Error(
      `TMDB ${response.status}: ${text.slice(0, 500)}`
    );
  }

  return response.json();
}


// ============================================================
// ======================= FILTER HELPERS =====================
// ============================================================

function matchesLanguage(item, allowedLanguages) {

  if (!allowedLanguages || allowedLanguages.length === 0) {
    return true;
  }

  if (!item.original_language) {
    return false;
  }

  return allowedLanguages.includes(item.original_language);
}


function matchesGenres(
  item,
  includeGenres = [],
  excludeGenres = []
) {

  const genres = item.genre_ids || [];

  // Required genres
  if (includeGenres.length > 0) {

    const hasRequiredGenre =
      includeGenres.some(id => genres.includes(Number(id)));

    if (!hasRequiredGenre) {
      return false;
    }
  }

  // Excluded genres
  if (excludeGenres.length > 0) {

    const hasExcludedGenre =
      excludeGenres.some(id => genres.includes(Number(id)));

    if (hasExcludedGenre) {
      return false;
    }
  }

  return true;
}


function passesMovieFilters(movie) {

  if (!movie) {
    return false;
  }

  if (
    Number(movie.popularity || 0) <
    Number(MOVIE_FILTERS.minPopularity)
  ) {
    return false;
  }

  if (
    !matchesLanguage(
      movie,
      MOVIE_FILTERS.originalLanguages
    )
  ) {
    return false;
  }

  if (
    !matchesGenres(
      movie,
      MOVIE_FILTERS.includeGenres,
      MOVIE_FILTERS.excludeGenres
    )
  ) {
    return false;
  }

  return true;
}


function passesTVFilters(show) {

  if (!show) {
    return false;
  }

  if (
    Number(show.popularity || 0) <
    Number(TV_FILTERS.minPopularity)
  ) {
    return false;
  }

  if (
    !matchesLanguage(
      show,
      TV_FILTERS.originalLanguages
    )
  ) {
    return false;
  }

  if (
    !matchesGenres(
      show,
      TV_FILTERS.includeGenres,
      TV_FILTERS.excludeGenres
    )
  ) {
    return false;
  }

  return true;
}


// ============================================================
// ======================= MOVIE DISCOVERY ====================
// ============================================================
//
// IMPORTANT:
//
// We DO NOT start with /movie/popular.
//
// We start with recent movie releases.
//
// TMDB Discover:
//
// release_date.gte
// release_date.lte
// with_release_type=4 (Digital)
// sort_by=popularity.desc
//
// Then OUR code applies minPopularity and other filters.
//
// ============================================================

async function discoverRecentMovies() {

  const minDate =
    daysAgo(MOVIE_FILTERS.lookbackDays);

  const maxDate =
    today();

  const results = [];

  for (
    let page = 1;
    page <= MOVIE_FILTERS.maxPages;
    page++
  ) {

    const params = {

      page,

      sort_by: "popularity.desc",

      include_adult:
        MOVIE_FILTERS.includeAdult,

      include_video: false,

      "release_date.gte": minDate,

      "release_date.lte": maxDate,

      with_release_type:
        MOVIE_FILTERS.requireDigitalRelease
          ? "4"
          : undefined
    };


    if (
      MOVIE_FILTERS.originalLanguages &&
      MOVIE_FILTERS.originalLanguages.length === 1
    ) {

      params.with_original_language =
        MOVIE_FILTERS.originalLanguages[0];

    }


    if (SETTINGS.region) {
      params.region = SETTINGS.region;
    }


    // Remove undefined values
    Object.keys(params).forEach(key => {

      if (params[key] === undefined) {
        delete params[key];
      }

    });


    const data =
      await tmdb("/discover/movie", params);


    if (!data.results || data.results.length === 0) {
      break;
    }


    results.push(...data.results);


    if (page >= data.total_pages) {
      break;
    }
  }


  // Remove duplicates
  const unique = [];

  const seen = new Set();

  for (const movie of results) {

    if (seen.has(movie.id)) {
      continue;
    }

    seen.add(movie.id);

    unique.push(movie);
  }


  // Popularity first
  unique.sort(
    (a, b) =>
      Number(b.popularity || 0) -
      Number(a.popularity || 0)
  );


  return unique;
}


// ============================================================
// ===================== MOVIE RELEASE DATA ===================
// ============================================================

async function getDigitalRelease(tmdbId) {

  const data =
    await tmdb(`/movie/${tmdbId}/release_dates`);


  const releases = [];


  for (const country of data.results || []) {

    for (const release of country.release_dates || []) {

      if (Number(release.type) !== 4) {
        continue;
      }

      if (!release.release_date) {
        continue;
      }

      releases.push({
        country: country.iso_3166_1,
        date: release.release_date.slice(0, 10)
      });
    }
  }


  if (releases.length === 0) {
    return null;
  }


  // Most recent digital release first
  releases.sort(
    (a, b) =>
      new Date(b.date) -
      new Date(a.date)
  );


  return releases[0];
}


// ============================================================
// ====================== MOVIE CHECK =========================
// ============================================================

async function checkMovies() {

  console.log("🎬 Checking new movies...");


  const movies =
    await discoverRecentMovies();


  console.log(
    `🎬 Found ${movies.length} recent movie candidates.`
  );


  let notified = 0;


  for (const movie of movies) {

    try {

      // Popularity + language + genre filters
      if (!passesMovieFilters(movie)) {
        continue;
      }


      // Prevent duplicate notification
      const alreadySent =
        db.prepare(`
          SELECT 1
          FROM popular_movie_notifications
          WHERE tmdb_id = ?
        `).get(movie.id);


      if (alreadySent) {
        continue;
      }


      // Verify actual digital release
      const digital =
        await getDigitalRelease(movie.id);


      if (!digital) {
        continue;
      }


      // Make sure digital release is within our lookback period
      const releaseDate =
        new Date(`${digital.date}T00:00:00Z`);

      const oldestDate =
        new Date(
          `${daysAgo(
            MOVIE_FILTERS.lookbackDays
          )}T00:00:00Z`
        );


      if (releaseDate < oldestDate) {
        continue;
      }


      // Get full movie details
      const details =
        await tmdb(`/movie/${movie.id}`);


      const poster =
        details.poster_path ||
        movie.poster_path;


      const genres =
        (details.genres || [])
          .map(g => g.name)
          .join(", ");


      await sendMovieNotification({

        id: movie.id,

        title:
          details.title ||
          movie.title ||
          movie.original_title,

        overview:
          details.overview ||
          movie.overview,

        posterPath: poster,

        popularity:
          Number(details.popularity || movie.popularity || 0),

        releaseDate:
          details.release_date ||
          movie.release_date,

        digitalDate:
          digital.date,

        digitalCountry:
          digital.country,

        genres,

        language:
          details.original_language ||
          movie.original_language
      });


      db.prepare(`
        INSERT INTO popular_movie_notifications
        (
          tmdb_id,
          title,
          release_date,
          digital_date,
          popularity
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(

        movie.id,

        details.title ||
        movie.title ||
        movie.original_title,

        details.release_date ||
        movie.release_date ||
        null,

        digital.date,

        Number(
          details.popularity ||
          movie.popularity ||
          0
        )
      );


      notified++;

      // Small delay to be friendly to APIs
      await sleep(250);

    } catch (error) {

      console.error(
        `❌ Movie ${movie.id} failed:`,
        error.message
      );
    }
  }


  console.log(
    `🎬 New movies notified: ${notified}`
  );
}


// ============================================================
// ======================== TV DISCOVERY ======================
// ============================================================
//
// We search TV activity from the last 7 days.
//
// This captures:
// - New series
// - Returning series
// - Shows with new episodes
//
// Then we inspect the actual seasons to determine whether
// the event is a NEW SERIES or NEW SEASON.
//
// ============================================================

async function discoverRecentTV() {

  const minDate =
    daysAgo(TV_FILTERS.episodeLookbackDays);

  const maxDate =
    today();

  const results = [];


  for (
    let page = 1;
    page <= TV_FILTERS.maxPages;
    page++
  ) {

    const params = {

      page,

      sort_by: "popularity.desc",

      include_adult:
        TV_FILTERS.includeAdult,

      "air_date.gte": minDate,

      "air_date.lte": maxDate,

      timezone:
        SETTINGS.timezone
    };


    if (
      TV_FILTERS.originalLanguages &&
      TV_FILTERS.originalLanguages.length === 1
    ) {

      params.with_original_language =
        TV_FILTERS.originalLanguages[0];

    }


    Object.keys(params).forEach(key => {

      if (params[key] === undefined) {
        delete params[key];
      }

    });


    const data =
      await tmdb("/discover/tv", params);


    if (!data.results || data.results.length === 0) {
      break;
    }


    results.push(...data.results);


    if (page >= data.total_pages) {
      break;
    }
  }


  const unique = [];

  const seen = new Set();


  for (const show of results) {

    if (seen.has(show.id)) {
      continue;
    }

    seen.add(show.id);

    unique.push(show);
  }


  unique.sort(
    (a, b) =>
      Number(b.popularity || 0) -
      Number(a.popularity || 0)
  );


  return unique;
}


// ============================================================
// ======================= TV DETAILS =========================
// ============================================================

async function getTVDetails(tmdbId) {

  return tmdb(`/tv/${tmdbId}`);
}


// ============================================================
// ======================= SEASON CHECK =======================
// ============================================================

function getRecentSeasons(
  show,
  minDate,
  maxDate
) {

  const seasons =
    (show.seasons || [])
      .filter(season => {

        // Ignore specials
        if (Number(season.season_number) === 0) {
          return false;
        }

        if (!season.air_date) {
          return false;
        }

        const date =
          season.air_date.slice(0, 10);

        return (
          date >= minDate &&
          date <= maxDate
        );
      })
      .sort(
        (a, b) =>
          new Date(b.air_date) -
          new Date(a.air_date)
      );


  return seasons.slice(
    0,
    TV_FILTERS.seasonsToInspect
  );
}


// ============================================================
// ======================= EPISODE CHECK ======================
// ============================================================

async function getRecentEpisodes(
  showId,
  seasonNumber,
  minDate,
  maxDate
) {

  const data =
    await tmdb(
      `/tv/${showId}/season/${seasonNumber}`
    );


  return (data.episodes || [])
    .filter(episode => {

      if (!episode.air_date) {
        return false;
      }

      const date =
        episode.air_date.slice(0, 10);

      return (
        date >= minDate &&
        date <= maxDate
      );
    });
}


// ============================================================
// ========================= TV CHECK ==========================
// ============================================================

async function checkTV() {

  console.log("📺 Checking new TV activity...");


  const shows =
    await discoverRecentTV();


  console.log(
    `📺 Found ${shows.length} recent TV candidates.`
  );


  const minDate =
    daysAgo(TV_FILTERS.episodeLookbackDays);

  const maxDate =
    today();


  let newSeriesCount = 0;
  let newSeasonCount = 0;
  let episodeCount = 0;


  for (const show of shows) {

    try {

      if (!passesTVFilters(show)) {
        continue;
      }


      const details =
        await getTVDetails(show.id);


      // Apply filters again using full details
      if (!passesTVFilters(details)) {
        continue;
      }


      const recentSeasons =
        getRecentSeasons(
          details,
          minDate,
          maxDate
        );


      // ------------------------------------------------------
      // NEW SERIES / NEW SEASON
      // ------------------------------------------------------

      for (const season of recentSeasons) {

        const seasonNumber =
          Number(season.season_number);


        // Determine if this is the first season
        const isNewSeries =
          seasonNumber === 1;


        // Avoid duplicate season notifications
        const alreadySent =
          db.prepare(`
            SELECT 1
            FROM tv_season_notifications
            WHERE tmdb_id = ?
            AND season = ?
          `).get(
            show.id,
            seasonNumber
          );


        if (alreadySent) {
          continue;
        }


        const notificationType =
          isNewSeries
            ? "NEW SERIES"
            : "NEW SEASON";


        await sendTVSeasonNotification({

          id: show.id,

          showName:
            details.name ||
            show.name,

          seasonNumber,

          seasonName:
            season.name ||
            `Season ${seasonNumber}`,

          airDate:
            season.air_date,

          popularity:
            Number(
              details.popularity ||
              show.popularity ||
              0
            ),

          posterPath:
            details.poster_path ||
            show.poster_path,

          overview:
            details.overview ||
            show.overview,

          genres:
            (details.genres || [])
              .map(g => g.name)
              .join(", "),

          language:
            details.original_language ||
            show.original_language,

          notificationType
        });


        db.prepare(`
          INSERT INTO tv_season_notifications
          (
            tmdb_id,
            season,
            show_name,
            season_name,
            air_date,
            popularity
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(

          show.id,

          seasonNumber,

          details.name ||
          show.name,

          season.name ||
          `Season ${seasonNumber}`,

          season.air_date,

          Number(
            details.popularity ||
            show.popularity ||
            0
          )
        );


        if (isNewSeries) {
          newSeriesCount++;
        } else {
          newSeasonCount++;
        }


        await sleep(250);
      }


      // ------------------------------------------------------
      // RECENT EPISODES
      // ------------------------------------------------------

      const seasonsToCheck =
        recentSeasons.length > 0
          ? recentSeasons
          : (details.seasons || [])
              .filter(s =>
                Number(s.season_number) > 0
              )
              .sort(
                (a, b) =>
                  Number(b.season_number) -
                  Number(a.season_number)
              )
              .slice(
                0,
                TV_FILTERS.seasonsToInspect
              );


      for (const season of seasonsToCheck) {

        const seasonNumber =
          Number(season.season_number);


        const episodes =
          await getRecentEpisodes(
            show.id,
            seasonNumber,
            minDate,
            maxDate
          );


        for (const episode of episodes) {

          const alreadySent =
            db.prepare(`
              SELECT 1
              FROM popular_episode_notifications
              WHERE tmdb_id = ?
              AND season = ?
              AND episode = ?
            `).get(

              show.id,

              seasonNumber,

              Number(episode.episode_number)
            );


          if (alreadySent) {
            continue;
          }


          await sendTVEpisodeNotification({

            id: show.id,

            showName:
              details.name ||
              show.name,

            season:
              seasonNumber,

            episode:
              Number(episode.episode_number),

            episodeName:
              episode.name ||
              `Episode ${episode.episode_number}`,

            airDate:
              episode.air_date,

            popularity:
              Number(
                details.popularity ||
                show.popularity ||
                0
              ),

            posterPath:
              details.poster_path ||
              show.poster_path,

            overview:
              episode.overview ||
              details.overview,

            language:
              details.original_language ||
              show.original_language
          });


          db.prepare(`
            INSERT INTO popular_episode_notifications
            (
              tmdb_id,
              season,
              episode,
              show_name,
              episode_name,
              air_date,
              notification_type
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(

            show.id,

            seasonNumber,

            Number(episode.episode_number),

            details.name ||
            show.name,

            episode.name ||
            `Episode ${episode.episode_number}`,

            episode.air_date,

            "NEW EPISODE"
          );


          episodeCount++;

          await sleep(250);
        }
      }

    } catch (error) {

      console.error(
        `❌ TV ${show.id} failed:`,
        error.message
      );
    }
  }


  console.log(
    `📺 New series: ${newSeriesCount}`
  );

  console.log(
    `🔥 New seasons: ${newSeasonCount}`
  );

  console.log(
    `🎞️ New episodes: ${episodeCount}`
  );
}


// ============================================================
// ==================== TELEGRAM HELPERS ======================
// ============================================================

async function telegramRequest(
  method,
  body
) {

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {

    throw new Error(
      "Telegram environment variables are missing."
    );
  }


  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;


  const response =
    await fetch(url, {

      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify(body)
    });


  const data =
    await response.json();


  if (!data.ok) {

    throw new Error(
      data.description ||
      "Telegram API error"
    );
  }


  return data;
}


// ============================================================
// ======================= MOVIE MESSAGE ======================
// ============================================================

async function sendMovieNotification(movie) {

  const posterUrl =
    movie.posterPath
      ? `https://image.tmdb.org/t/p/${TELEGRAM_SETTINGS.posterSize}${movie.posterPath}`
      : null;


  const language =
    movie.language
      ? movie.language.toUpperCase()
      : "N/A";


  const caption =

`🎬 NEW MOVIE

${movie.title}

⭐ Popularity: ${Number(movie.popularity || 0).toFixed(1)}
🌐 Language: ${language}
📅 Digital: ${movie.digitalDate || "N/A"}
🎞️ Genre: ${movie.genres || "N/A"}

🔗 TMDB: https://www.themoviedb.org/movie/${movie.id}`;


  try {

    if (posterUrl) {

      await telegramRequest(
        "sendPhoto",
        {

          chat_id:
            TELEGRAM_CHAT_ID,

          photo:
            posterUrl,

          caption
        }
      );

      return;
    }


    await telegramRequest(
      "sendMessage",
      {

        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          caption
      }
    );

  } catch (error) {

    console.error(
      "⚠️ Movie poster notification failed:",
      error.message
    );


    // Fallback to text
    await telegramRequest(
      "sendMessage",
      {

        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          caption
      }
    );
  }
}


// ============================================================
// ===================== TV SEASON MESSAGE ====================
// ============================================================

async function sendTVSeasonNotification(show) {

  const posterUrl =
    show.posterPath
      ? `https://image.tmdb.org/t/p/${TELEGRAM_SETTINGS.posterSize}${show.posterPath}`
      : null;


  const language =
    show.language
      ? show.language.toUpperCase()
      : "N/A";


  const caption =

`${show.notificationType === "NEW SERIES"
  ? "🆕 NEW SERIES"
  : "🔥 NEW SEASON"}

${show.showName}

${show.seasonName}

⭐ Popularity: ${Number(show.popularity || 0).toFixed(1)}
🌐 Language: ${language}
📅 Premiere: ${show.airDate || "N/A"}
🎞️ Genre: ${show.genres || "N/A"}

🔗 TMDB: https://www.themoviedb.org/tv/${show.id}`;


  try {

    if (posterUrl) {

      await telegramRequest(
        "sendPhoto",
        {

          chat_id:
            TELEGRAM_CHAT_ID,

          photo:
            posterUrl,

          caption
        }
      );

      return;
    }


    await telegramRequest(
      "sendMessage",
      {

        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          caption
      }
    );

  } catch (error) {

    console.error(
      "⚠️ TV season poster notification failed:",
      error.message
    );


    await telegramRequest(
      "sendMessage",
      {

        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          caption
      }
    );
  }
}


// ============================================================
// ==================== TV EPISODE MESSAGE ====================
// ============================================================

async function sendTVEpisodeNotification(episode) {

  const posterUrl =
    episode.posterPath
      ? `https://image.tmdb.org/t/p/${TELEGRAM_SETTINGS.posterSize}${episode.posterPath}`
      : null;


  const language =
    episode.language
      ? episode.language.toUpperCase()
      : "N/A";


  const caption =

`📺 NEW EPISODE

${episode.showName}

S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")} — ${episode.episodeName}

⭐ Popularity: ${Number(episode.popularity || 0).toFixed(1)}
🌐 Language: ${language}
📅 Aired: ${episode.airDate || "N/A"}

🔗 TMDB: https://www.themoviedb.org/tv/${episode.id}`;


  try {

    if (posterUrl) {

      await telegramRequest(
        "sendPhoto",
        {

          chat_id:
            TELEGRAM_CHAT_ID,

          photo:
            posterUrl,

          caption
        }
      );

      return;
    }


    await telegramRequest(
      "sendMessage",
      {

        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          caption
      }
    );

  } catch (error) {

    console.error(
      "⚠️ TV episode poster notification failed:",
      error.message
    );


    await telegramRequest(
      "sendMessage",
      {

        chat_id:
          TELEGRAM_CHAT_ID,

        text:
          caption
      }
    );
  }
}


// ============================================================
// ======================= RUN EVERYTHING =====================
// ============================================================

let checkRunning = false;


async function runAllChecks() {

  if (checkRunning) {

    console.log(
      "⏳ A check is already running. Skipping."
    );

    return;
  }


  checkRunning = true;


  console.log("");
  console.log("========================================");
  console.log("🚀 STARTING RELEASE CHECK");
  console.log(new Date().toISOString());
  console.log("========================================");


  try {

    await checkMovies();

  } catch (error) {

    console.error(
      "❌ Movie check failed:",
      error.message
    );
  }


  try {

    await checkTV();

  } catch (error) {

    console.error(
      "❌ TV check failed:",
      error.message
    );
  }


  console.log("");
  console.log("========================================");
  console.log("✅ RELEASE CHECK FINISHED");
  console.log(new Date().toISOString());
  console.log("========================================");
  console.log("");


  checkRunning = false;
}


// ============================================================
// =========================== ROUTES ==========================
// ============================================================

app.get("/", (req, res) => {

  res.json({

    name:
      "Movie + TV Release Notifier",

    version:
      "4.0.0",

    status:
      "online",

    architecture: {

      movies:
        "Recent releases -> Digital -> Popularity -> Filters",

      tv:
        "Recent TV activity -> Popularity -> Filters -> New Series/New Season/Episode"
    },

    intervalHours:
      SETTINGS.checkIntervalHours,

    movieFilters:
      MOVIE_FILTERS,

    tvFilters:
      TV_FILTERS
  });
});


// ------------------------------------------------------------
// Manual complete check
// ------------------------------------------------------------

app.get("/run-all", async (req, res) => {

  if (checkRunning) {

    return res.json({
      success: false,
      message: "A check is already running."
    });
  }


  runAllChecks();


  res.json({

    success: true,

    message:
      "Movie and TV release check started."
  });
});


// ------------------------------------------------------------
// Status
// ------------------------------------------------------------

app.get("/status", (req, res) => {

  const movieCount =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM popular_movie_notifications
    `).get();


  const episodeCount =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM popular_episode_notifications
    `).get();


  const seasonCount =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM tv_season_notifications
    `).get();


  res.json({

    status: "online",

    version: "4.0.0",

    checkRunning,

    notifications: {

      movies:
        movieCount.count,

      seasons:
        seasonCount.count,

      episodes:
        episodeCount.count
    },

    filters: {

      movies:
        MOVIE_FILTERS,

      tv:
        TV_FILTERS
    }
  });
});


// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

app.get("/config", (req, res) => {

  res.json({

    settings: SETTINGS,

    movies: MOVIE_FILTERS,

    tv: TV_FILTERS,

    telegram: {

      posterSize:
        TELEGRAM_SETTINGS.posterSize
    }
  });
});


// ------------------------------------------------------------
// Test movie
// ------------------------------------------------------------

app.get(
  "/test-movie/:tmdbId",
  async (req, res) => {

    try {

      const id =
        Number(req.params.tmdbId);


      const movie =
        await tmdb(`/movie/${id}`);


      const digital =
        await getDigitalRelease(id);


      res.json({

        movie,

        digitalRelease:
          digital,

        passesFilters:
          passesMovieFilters(movie)
      });

    } catch (error) {

      res.status(500).json({

        error:
          error.message
      });
    }
  }
);


// ------------------------------------------------------------
// Test TV
// ------------------------------------------------------------

app.get(
  "/test-show/:tmdbId",
  async (req, res) => {

    try {

      const id =
        Number(req.params.tmdbId);


      const show =
        await getTVDetails(id);


      const minDate =
        daysAgo(
          TV_FILTERS.episodeLookbackDays
        );


      const maxDate =
        today();


      const recentSeasons =
        getRecentSeasons(
          show,
          minDate,
          maxDate
        );


      res.json({

        show,

        passesFilters:
          passesTVFilters(show),

        recentSeasons
      });

    } catch (error) {

      res.status(500).json({

        error:
          error.message
      });
    }
  }
);


// ============================================================
// ========================== SERVER ===========================
// ============================================================

app.listen(
  PORT,
  () => {

    console.log("");
    console.log("========================================");
    console.log("🎬 MOVIE + TV NOTIFIER");
    console.log("========================================");

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `⏰ Interval: ${SETTINGS.checkIntervalHours} hours`
    );

    console.log(
      `🕐 Timezone: ${SETTINGS.timezone}`
    );

    console.log("");
    console.log("MOVIE FILTERS:");
    console.log(
      JSON.stringify(
        MOVIE_FILTERS,
        null,
        2
      )
    );

    console.log("");
    console.log("TV FILTERS:");
    console.log(
      JSON.stringify(
        TV_FILTERS,
        null,
        2
      )
    );

    console.log("");
    console.log("========================================");
  }
);


// ============================================================
// ===================== STARTUP CHECK ========================
// ============================================================

setTimeout(
  () => {

    runAllChecks();

  },
  SETTINGS.startupDelaySeconds * 1000
);


// ============================================================
// ===================== AUTOMATIC CHECK ======================
// ============================================================

setInterval(
  () => {

    runAllChecks();

  },
  SETTINGS.checkIntervalHours *
  60 *
  60 *
  1000
);
