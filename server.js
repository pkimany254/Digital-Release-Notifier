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
 * Only notify about releases/episodes that happened
 * within this many days.
 */
const RELEASE_LOOKBACK_DAYS = 7;
const EPISODE_LOOKBACK_DAYS = 7;

/*
 * Number of TMDB pages to scan.
 * 20 results per page.
 */
const MOVIE_PAGES = 2;
const TV_PAGES = 2;

/*
 * Maximum unique movies/shows to inspect.
 */
const MAX_MOVIES = 30;
const MAX_SHOWS = 30;


/* =========================================================
   TV GENRE FILTERS
========================================================= */

/*
 * TMDB TV genre IDs we don't want in the notifier.
 *
 * 16    Animation
 * 99    Documentary
 * 10763 News
 * 10764 Reality
 * 10766 Soap
 * 10767 Talk
 *
 * We exclude Animation as well because the notifier
 * is intended to avoid anime/animated catalogs.
 */

const EXCLUDED_TV_GENRES = new Set([
  16,
  99,
  10763,
  10764,
  10766,
  10767
]);


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
 *
 * We keep the existing table name from the previous
 * version so the existing Railway volume continues
 * to work without creating another database.
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
   DATE HELPERS
========================================================= */

function getCutoffDate(days) {

  const date =
    new Date();

  date.setDate(
    date.getDate() - days
  );

  return date;
}


function formatDate(dateString) {

  if (!dateString) {
    return "";
  }

  const date =
    new Date(dateString);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return dateString;
  }

  return new Intl.DateTimeFormat(
    "en-GB",
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC"
    }
  ).format(date);
}


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
    `${separator}api_key=${encodeURIComponent(
      TMDB_API_KEY
    )}`;

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
          message,

        disable_web_page_preview:
          true
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

      if (!movie.id) {
        continue;
      }

      /*
       * Exclude animation because the notifier
       * is intended to avoid anime/animated titles.
       */

      if (
        Array.isArray(
          movie.genre_ids
        ) &&
        movie.genre_ids.includes(16)
      ) {
        continue;
      }

      movies.set(
        movie.id,
        movie
      );
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

    if (!movie.id) {
      continue;
    }

    if (
      Array.isArray(
        movie.genre_ids
      ) &&
      movie.genre_ids.includes(16)
    ) {
      continue;
    }

    movies.set(
      movie.id,
      movie
    );
  }


  /*
   * Sort by popularity.
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
   GET RECENT DIGITAL RELEASE
========================================================= */

async function getDigitalRelease(
  tmdbId
) {

  const data =
    await tmdb(
      `/movie/${tmdbId}/release_dates`
    );

  const cutoff =
    getCutoffDate(
      RELEASE_LOOKBACK_DAYS
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
        release.type !== 4
      ) {
        continue;
      }

      if (
        !release.release_date
      ) {
        continue;
      }

      const releaseDate =
        new Date(
          release.release_date
        );

      if (
        Number.isNaN(
          releaseDate.getTime()
        )
      ) {
        continue;
      }


      /*
       * Must already be released.
       */

      if (
        releaseDate > now
      ) {
        continue;
      }


      /*
       * IMPORTANT:
       *
       * Only consider recent digital releases.
       *
       * This prevents old releases such as:
       *
       * Spider-Man (2017)
       * Spider-Man: No Way Home (2022)
       *
       * from being reported as new.
       */

      if (
        releaseDate < cutoff
      ) {
        continue;
      }


      candidates.push({
        country:
          country.iso_3166_1,

        release_date:
          release.release_date
      });
    }
  }


  if (
    !candidates.length
  ) {

    return {
      available:
        false
    };
  }


  /*
   * If several countries have recent digital
   * releases, use the earliest one.
   */

  candidates.sort(
    (a, b) =>
      new Date(
        a.release_date
      ) -
      new Date(
        b.release_date
      )
  );


  return {
    available:
      true,

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
  let recentDigitalReleases = 0;
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
          `No recent digital release: ${movie.title}`
        );

        continue;
      }


      recentDigitalReleases++;


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
        `🔔 NEW DIGITAL RELEASE\n\n` +
        `🎬 ${movie.title}` +
        (
          year
            ? ` (${year})`
            : ""
        ) +
        `\n\n` +
        `💿 Digital release available` +
        `\n📅 ${formatDate(
          release.release_date
        )}`;


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

    recent_digital_releases:
      recentDigitalReleases,

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
   * Popular TV.
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

      if (!show.id) {
        continue;
      }

      shows.set(
        show.id,
        show
      );
    }
  }


  /*
   * Weekly trending TV.
   */

  const trending =
    await tmdb(
      "/trending/tv/week"
    );


  for (
    const show of trending.results || []
  ) {

    if (!show.id) {
      continue;
    }

    shows.set(
      show.id,
      show
    );
  }


  /*
   * Sort by popularity.
   */

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
   CHECK WHETHER SHOW SHOULD BE MONITORED
========================================================= */

function isAllowedTVShow(
  details
) {

  const genres =
    details.genres || [];


  /*
   * Exclude unwanted TV categories.
   */

  for (
    const genre of genres
  ) {

    if (
      EXCLUDED_TV_GENRES.has(
        genre.id
      )
    ) {

      return false;
    }
  }


  return true;
}


/* =========================================================
   CHECK POPULAR TV SHOW EPISODES
========================================================= */

async function checkPopularShows() {

  const shows =
    await getPopularShows();

  let checked = 0;
  let eligibleShows = 0;
  let availableEpisodes = 0;
  let notified = 0;
  let alreadyNotified = 0;
  let filtered = 0;
  let errors = 0;


  const cutoff =
    getCutoffDate(
      EPISODE_LOOKBACK_DAYS
    );


  const now =
    new Date();


  console.log(
    `Checking ${shows.length} popular/trending TV show(s)...`
  );


  for (
    const show of shows
  ) {

    try {

      checked++;


      /*
       * Get full show details.
       */

      const details =
        await tmdb(
          `/tv/${show.id}`
        );


      /*
       * Filter out reality, documentary,
       * talk, news, soap, animation/anime, etc.
       */

      if (
        !isAllowedTVShow(
          details
        )
      ) {

        filtered++;

        console.log(
          `Filtered TV show: ${show.name}`
        );

        continue;
      }


      eligibleShows++;


      /*
       * Get all valid seasons.
       *
       * Season 0 = specials.
       * We don't monitor specials.
       */

      const seasons =
        (details.seasons || [])
          .filter(
            season =>
              season.season_number > 0
          );


      if (
        !seasons.length
      ) {
        continue;
      }


      /*
       * Check every season that could contain
       * a recent episode.
       *
       * We inspect the latest season first.
       */

      seasons.sort(
        (a, b) =>
          b.season_number -
          a.season_number
      );


      let recentEpisodes =
        [];


      /*
       * Usually the latest season is enough.
       * But checking the first two seasons protects
       * against cases where TMDB has unusual season
       * ordering.
       */

      const seasonsToCheck =
        seasons.slice(
          0,
          2
        );


      for (
        const season
          of seasonsToCheck
      ) {

        const seasonData =
          await tmdb(
            `/tv/${show.id}/season/${season.season_number}`
          );


        for (
          const episode
            of seasonData.episodes || []
        ) {

          if (
            !episode.air_date
          ) {
            continue;
          }


          const airDate =
            new Date(
              episode.air_date
            );


          if (
            Number.isNaN(
              airDate.getTime()
            )
          ) {
            continue;
          }


          /*
           * Episode must have already aired.
           */

          if (
            airDate > now
          ) {
            continue;
          }


          /*
           * Episode must be recent.
           */

          if (
            airDate < cutoff
          ) {
            continue;
          }


          recentEpisodes.push({
            season:
              season.season_number,

            episode:
              episode.episode_number,

            name:
              episode.name,

            air_date:
              episode.air_date
          });
        }
      }


      /*
       * Remove duplicate episodes.
       */

      const uniqueEpisodes =
        new Map();


      for (
        const episode
          of recentEpisodes
      ) {

        uniqueEpisodes.set(
          `${episode.season}-${episode.episode}`,
          episode
        );
      }


      recentEpisodes =
        Array.from(
          uniqueEpisodes.values()
        );


      if (
        !recentEpisodes.length
      ) {
        continue;
      }


      availableEpisodes +=
        recentEpisodes.length;


      /*
       * Sort oldest → newest.
       */

      recentEpisodes.sort(
        (a, b) =>
          new Date(
            a.air_date
          ) -
          new Date(
            b.air_date
          )
      );


      /*
       * Notify each episode once.
       */

      for (
        const episode
          of recentEpisodes
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
            episode.season,
            episode.episode
          );


        if (existing) {

          alreadyNotified++;

          continue;
        }


        const episodeCode =
          `S${String(
            episode.season
          ).padStart(
            2,
            "0"
          )}` +
          `E${String(
            episode.episode
          ).padStart(
            2,
            "0"
          )}`;


        const message =
          `📺 NEW EPISODE\n\n` +
          `🎬 ${show.name}\n` +
          `${episodeCode} — ${episode.name}` +
          `\n\n` +
          `📅 ${formatDate(
            episode.air_date
          )}`;


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
          episode.season,
          episode.episode,
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

    eligible_shows:
      eligibleShows,

    filtered,

    available_episodes:
      availableEpisodes,

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


    /*
     * MOVIES
     */

    const movies =
      await checkPopularMovies();


    lastCheck.movies =
      movies;


    console.log(
      "Movie check completed:",
      movies
    );


    /*
     * TV SHOWS
     */

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


    console.log(
      "All checks completed."
    );


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
   MANUAL FULL CHECK
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

      return res.status(
        400
      ).json({
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
          release,

        lookback_days:
          RELEASE_LOOKBACK_DAYS
      });

    } catch (error) {

      console.error(
        error
      );


      res.status(
        500
      ).json({
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

      return res.status(
        400
      ).json({
        error:
          "Invalid TMDB ID"
      });
    }


    try {

      const details =
        await tmdb(
          `/tv/${tmdbId}`
        );


      const allowed =
        isAllowedTVShow(
          details
        );


      if (!allowed) {

        return res.json({
          success:
            true,

          title:
            details.name,

          allowed:
            false,

          reason:
            "Filtered TV genre",

          recent_released_episodes:
            []
        });
      }


      const seasons =
        (details.seasons || [])
          .filter(
            season =>
              season.season_number > 0
          );


      if (
        !seasons.length
      ) {

        return res.json({
          success:
            true,

          title:
            details.name,

          allowed:
            true,

          episodes:
            []
        });
      }


      seasons.sort(
        (a, b) =>
          b.season_number -
          a.season_number
      );


      const cutoff =
        getCutoffDate(
          EPISODE_LOOKBACK_DAYS
        );


      const now =
        new Date();


      const recentEpisodes =
        [];


      for (
        const season
          of seasons.slice(0, 2)
      ) {

        const seasonData =
          await tmdb(
            `/tv/${tmdbId}/season/${season.season_number}`
          );


        for (
          const episode
            of seasonData.episodes || []
        ) {

          if (
            !episode.air_date
          ) {
            continue;
          }


          const airDate =
            new Date(
              episode.air_date
            );


          if (
            airDate > now ||
            airDate < cutoff
          ) {
            continue;
          }


          recentEpisodes.push({
            season:
              season.season_number,

            episode:
              episode.episode_number,

            name:
              episode.name,

            air_date:
              episode.air_date
          });
        }
      }


      res.json({
        success:
          true,

        title:
          details.name,

        tmdb_id:
          tmdbId,

        allowed:
          true,

        lookback_days:
          EPISODE_LOOKBACK_DAYS,

        recent_released_episodes:
          recentEpisodes
      });

    } catch (error) {

      console.error(
        error
      );


      res.status(
        500
      ).json({
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
        "2.1.0",

      monitoring:
        "TMDB popular and trending",

      movie_release_window:
        `${RELEASE_LOOKBACK_DAYS} days`,

      episode_release_window:
        `${EPISODE_LOOKBACK_DAYS} days`
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
