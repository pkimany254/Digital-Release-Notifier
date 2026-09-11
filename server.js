const express = require("express");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_API_KEY =
  process.env.TMDB_API_KEY;

const TORBOX_API_KEY =
  process.env.TORBOX_API_KEY;

const TORBOX_API =
  "https://api.torbox.app/v1";

const ORION_API_KEY =
  process.env.ORION_API_KEY;

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;

app.use(express.json());

/* =========================================================
   CONFIGURATION
   Edit these values directly in the script and redeploy
   to change behavior. No env vars / runtime API for these
   by design.
========================================================= */

/*
 * How often to run the automatic check.
 */
const CHECK_INTERVAL =
  60 * 60 * 1000; // 1 hour

const STARTUP_DELAY =
  15 * 1000;

/*
 * How far back to look for a "new" digital movie release,
 * a "new" TV episode, and a "new" (renewed) TV season.
 */
const MOVIE_RELEASE_LOOKBACK_DAYS = 7;
const EPISODE_LOOKBACK_DAYS = 1;
const SEASON_RENEWAL_LOOKBACK_DAYS = 14;

/*
 * Minimum TMDB "popularity" score (the same `popularity`
 * field TMDB returns on every movie/show object) required
 * to notify. TMDB discover results are fetched sorted by
 * popularity descending, so raising these numbers both
 * filters out noise AND lets us stop paging early.
 *
 * Set to 0 to disable popularity filtering entirely.
 */
const MIN_MOVIE_POPULARITY = 20;
const MIN_TV_EPISODE_POPULARITY = 20;

/*
 * Renewals are specifically meant to surface *popular*
 * series that got a new season, so this threshold is
 * intentionally higher than the plain episode one.
 */
const MIN_TV_RENEWAL_POPULARITY = 40;

/*
 * Safety caps on how many discover pages we'll ever page
 * through in one run (20 results per page), in case a
 * threshold is set very low.
 */
const MAX_MOVIE_PAGES = 15;
const MAX_TV_EPISODE_PAGES = 15;
const MAX_TV_RENEWAL_PAGES = 15;


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
 * 10751 Family
 * 35    Comedy
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
  10767,
  35,
  10751
]);

const EXCLUDED_TV_GENRES_PARAM =
  Array.from(EXCLUDED_TV_GENRES).join(",");


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


/*
 * TV season renewals already notified about.
 * Season 1 is never inserted here (a season 1 is a show
 * premiere, not a renewal) — see isRenewalSeason().
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS popular_season_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    show_title TEXT NOT NULL,
    air_date TEXT,
    notified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tmdb_id, season)
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


function toISODate(date) {

  return date
    .toISOString()
    .slice(0, 10);
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
   DISCOVER: RECENTLY-DIGITALLY-RELEASED MOVIES
   (replaces scanning /movie/popular pages)
========================================================= */

async function discoverRecentDigitalMovies() {

  const cutoff =
    toISODate(
      getCutoffDate(
        MOVIE_RELEASE_LOOKBACK_DAYS
      )
    );

  const today =
    toISODate(
      new Date()
    );

  const movies =
    new Map();


  for (
    let page = 1;
    page <= MAX_MOVIE_PAGES;
    page++
  ) {

    const data =
      await tmdb(
        `/discover/movie` +
        `?sort_by=popularity.desc` +
        `&with_release_type=4` + // 4 = Digital
        `&release_date.gte=${cutoff}` +
        `&release_date.lte=${today}` +
        `&page=${page}`
      );

    const results =
      data.results || [];

    if (!results.length) {
      break;
    }

    let stoppedEarly =
      false;

    for (
      const movie of results
    ) {

      if (!movie.id) {
        continue;
      }

      /*
       * Results are sorted by popularity descending,
       * so once we drop below the threshold every
       * remaining result (this page and beyond) will
       * also be below it.
       */

      if (
        (movie.popularity || 0) <
        MIN_MOVIE_POPULARITY
      ) {

        stoppedEarly = true;

        break;
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

    if (
      stoppedEarly ||
      page >= (data.total_pages || 1)
    ) {
      break;
    }
  }

  return Array.from(
    movies.values()
  );
}


/* =========================================================
   GET EXACT DIGITAL RELEASE DATE FOR A MOVIE
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
      MOVIE_RELEASE_LOOKBACK_DAYS
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
       * Only consider recent digital releases so we
       * don't re-report old catalog titles.
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
   CHECK NEWLY-RELEASED MOVIES
========================================================= */

async function checkNewMovies() {

  const movies =
    await discoverRecentDigitalMovies();

  let checked = 0;
  let confirmedDigitalReleases = 0;
  let notified = 0;
  let alreadyNotified = 0;
  let errors = 0;


  console.log(
    `Checking ${movies.length} recently-digitally-released movie(s)...`
  );


  for (
    const movie of movies
  ) {

    try {

      checked++;


      /*
       * discover/movie's release_date.gte/lte filter is
       * matched against release dates across any region,
       * so we still confirm + pull the exact matching
       * date via release_dates for the notification text.
       */

      const release =
        await getDigitalRelease(
          movie.id
        );


      if (
        !release.available
      ) {

        console.log(
          `Discover matched but no confirmed digital release: ${movie.title}`
        );

        continue;
      }


      confirmedDigitalReleases++;


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

    confirmed_digital_releases:
      confirmedDigitalReleases,

    notified,

    already_notified:
      alreadyNotified,

    errors
  };
}


/* =========================================================
   DISCOVER: TV SHOWS WITH A RECENTLY-AIRED EPISODE
   (replaces scanning /tv/popular pages)
========================================================= */

async function discoverShowsWithRecentEpisodes() {

  const cutoff =
    toISODate(
      getCutoffDate(
        EPISODE_LOOKBACK_DAYS
      )
    );

  const today =
    toISODate(
      new Date()
    );

  const shows =
    new Map();


  for (
    let page = 1;
    page <= MAX_TV_EPISODE_PAGES;
    page++
  ) {

    const data =
      await tmdb(
        `/discover/tv` +
        `?sort_by=popularity.desc` +
        `&without_genres=${EXCLUDED_TV_GENRES_PARAM}` +
        `&air_date.gte=${cutoff}` +
        `&air_date.lte=${today}` +
        `&page=${page}`
      );

    const results =
      data.results || [];

    if (!results.length) {
      break;
    }

    let stoppedEarly =
      false;

    for (
      const show of results
    ) {

      if (!show.id) {
        continue;
      }

      if (
        (show.popularity || 0) <
        MIN_TV_EPISODE_POPULARITY
      ) {

        stoppedEarly = true;

        break;
      }

      shows.set(
        show.id,
        show
      );
    }

    if (
      stoppedEarly ||
      page >= (data.total_pages || 1)
    ) {
      break;
    }
  }

  return Array.from(
    shows.values()
  );
}


/* =========================================================
   DISCOVER: POPULAR TV SHOWS (candidate pool for renewals)
========================================================= */

async function discoverPopularShowsForRenewalCheck() {

  const shows =
    new Map();


  for (
    let page = 1;
    page <= MAX_TV_RENEWAL_PAGES;
    page++
  ) {

    const data =
      await tmdb(
        `/discover/tv` +
        `?sort_by=popularity.desc` +
        `&without_genres=${EXCLUDED_TV_GENRES_PARAM}` +
        `&page=${page}`
      );

    const results =
      data.results || [];

    if (!results.length) {
      break;
    }

    let stoppedEarly =
      false;

    for (
      const show of results
    ) {

      if (!show.id) {
        continue;
      }

      if (
        (show.popularity || 0) <
        MIN_TV_RENEWAL_POPULARITY
      ) {

        stoppedEarly = true;

        break;
      }

      shows.set(
        show.id,
        show
      );
    }

    if (
      stoppedEarly ||
      page >= (data.total_pages || 1)
    ) {
      break;
    }
  }

  return Array.from(
    shows.values()
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
   * Defensive re-check: without_genres is applied
   * server-side in discover/tv, but we confirm here
   * too since we fetch full details anyway.
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


/*
 * A season only counts as a "renewal" if it's not the
 * show's first season — season 1 is the show's premiere,
 * not a renewal.
 */

function isRenewalSeason(
  seasonNumber
) {

  return seasonNumber > 1;
}


/* =========================================================
   CHECK NEWLY-AIRED EPISODES OF DISCOVERED SHOWS
========================================================= */

async function checkNewTVEpisodes() {

  const shows =
    await discoverShowsWithRecentEpisodes();

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
    `Checking ${shows.length} show(s) with a recently-aired episode...`
  );


  for (
    const show of shows
  ) {

    try {

      checked++;


      const details =
        await tmdb(
          `/tv/${show.id}`
        );


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


      const seasons =
        (details.seasons || [])
          .filter(
            season =>
              season.season_number > 0
          )
          .sort(
            (a, b) =>
              b.season_number -
              a.season_number
          )
          .slice(
            0,
            2
          );


      let recentEpisodes =
        [];


      for (
        const season
          of seasons
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


          if (
            airDate > now
          ) {
            continue;
          }


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


      recentEpisodes.sort(
        (a, b) =>
          new Date(
            a.air_date
          ) -
          new Date(
            b.air_date
          )
      );


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
        `TV episode check failed for ${show.name}:`,
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
   CHECK FOR RENEWED SEASONS (announced, not yet aired)
========================================================= */

async function checkTVRenewals() {

  const shows =
    await discoverPopularShowsForRenewalCheck();

  let checked = 0;
  let eligibleShows = 0;
  let filtered = 0;
  let renewalsFound = 0;
  let notified = 0;
  let alreadyNotified = 0;
  let errors = 0;


  const cutoff =
    getCutoffDate(
      SEASON_RENEWAL_LOOKBACK_DAYS
    );


  console.log(
    `Checking ${shows.length} popular show(s) for season renewals...`
  );


  for (
    const show of shows
  ) {

    try {

      checked++;


      const details =
        await tmdb(
          `/tv/${show.id}`
        );


      if (
        !isAllowedTVShow(
          details
        )
      ) {

        filtered++;

        continue;
      }


      eligibleShows++;


      const seasons =
        (details.seasons || [])
          .filter(
            season =>
              isRenewalSeason(
                season.season_number
              )
          );


      for (
        const season
          of seasons
      ) {

        if (
          !season.air_date
        ) {
          continue;
        }

        const airDate =
          new Date(
            season.air_date
          );

        if (
          Number.isNaN(
            airDate.getTime()
          )
        ) {
          continue;
        }

        /*
         * IMPORTANT: unlike episode checks, we notify
         * as soon as the season's air_date is set and
         * recent — even if that date is in the future.
         * That's the "renewal announcement" signal.
         * We only require it not be stale.
         */

        if (
          airDate < cutoff
        ) {
          continue;
        }


        renewalsFound++;


        const existing =
          db.prepare(`
            SELECT id
            FROM popular_season_notifications
            WHERE tmdb_id = ?
              AND season = ?
          `).get(
            show.id,
            season.season_number
          );


        if (existing) {

          alreadyNotified++;

          continue;
        }


        const airDateIsFuture =
          airDate > new Date();


        const message =
          `🔁 SERIES RENEWED\n\n` +
          `🎬 ${show.name}\n` +
          `Season ${season.season_number}` +
          (
            season.name &&
            season.name !==
              `Season ${season.season_number}`
              ? ` — ${season.name}`
              : ""
          ) +
          `\n\n` +
          (
            airDateIsFuture
              ? `📅 Premieres ${formatDate(
                  season.air_date
                )}`
              : `📅 ${formatDate(
                  season.air_date
                )}`
          );


        await sendTelegramNotification(
          message
        );


        db.prepare(`
          INSERT INTO popular_season_notifications (
            tmdb_id,
            season,
            show_title,
            air_date
          )
          VALUES (?, ?, ?, ?)
        `).run(
          show.id,
          season.season_number,
          show.name,
          season.air_date
        );


        notified++;


        console.log(
          `NOTIFIED renewal: ${show.name} Season ${season.season_number}`
        );
      }

    } catch (error) {

      errors++;

      console.error(
        `Renewal check failed for ${show.name}:`,
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

    renewals_found:
      renewalsFound,

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

  episodes:
    null,

  renewals:
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

    episodes:
      null,

    renewals:
      null,

    error:
      null
  };


  try {

    console.log(
      "========================================"
    );

    console.log(
      "RUNNING NEW-RELEASE CHECK"
    );

    console.log(
      "========================================"
    );


    /*
     * NEW MOVIES
     */

    const movies =
      await checkNewMovies();


    lastCheck.movies =
      movies;


    console.log(
      "Movie check completed:",
      movies
    );


    /*
     * NEW TV EPISODES
     */

    const episodes =
      await checkNewTVEpisodes();


    lastCheck.episodes =
      episodes;


    console.log(
      "TV episode check completed:",
      episodes
    );


    /*
     * TV RENEWALS
     */

    const renewals =
      await checkTVRenewals();


    lastCheck.renewals =
      renewals;


    console.log(
      "TV renewal check completed:",
      renewals
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

      episodes,

      renewals
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

      episodes:
        lastCheck.episodes,

      renewals:
        lastCheck.renewals
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
        lastCheck,

      config: {
        check_interval_ms:
          CHECK_INTERVAL,

        movie_release_lookback_days:
          MOVIE_RELEASE_LOOKBACK_DAYS,

        episode_lookback_days:
          EPISODE_LOOKBACK_DAYS,

        season_renewal_lookback_days:
          SEASON_RENEWAL_LOOKBACK_DAYS,

        min_movie_popularity:
          MIN_MOVIE_POPULARITY,

        min_tv_episode_popularity:
          MIN_TV_EPISODE_POPULARITY,

        min_tv_renewal_popularity:
          MIN_TV_RENEWAL_POPULARITY
      }
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

          popularity:
            movie.popularity,

          release_date:
            movie.release_date
        },

        digital_release:
          release,

        lookback_days:
          MOVIE_RELEASE_LOOKBACK_DAYS
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
   TEST TV SHOW (episodes + renewal check)
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

          popularity:
            details.popularity,

          allowed:
            false,

          reason:
            "Filtered TV genre",

          recent_episodes:
            [],

          recent_season_renewals:
            []
        });
      }


      const seasons =
        (details.seasons || [])
          .filter(
            season =>
              season.season_number > 0
          )
          .sort(
            (a, b) =>
              b.season_number -
              a.season_number
          );


      const episodeCutoff =
        getCutoffDate(
          EPISODE_LOOKBACK_DAYS
        );

      const seasonCutoff =
        getCutoffDate(
          SEASON_RENEWAL_LOOKBACK_DAYS
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
            airDate < episodeCutoff
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


      const recentSeasonRenewals =
        seasons
          .filter(
            season =>
              isRenewalSeason(
                season.season_number
              ) &&
              season.air_date &&
              new Date(
                season.air_date
              ) >= seasonCutoff
          )
          .map(
            season => ({
              season:
                season.season_number,

              name:
                season.name,

              air_date:
                season.air_date,

              is_future:
                new Date(
                  season.air_date
                ) > now
            })
          );


      res.json({
        success:
          true,

        title:
          details.name,

        tmdb_id:
          tmdbId,

        popularity:
          details.popularity,

        allowed:
          true,

        episode_lookback_days:
          EPISODE_LOOKBACK_DAYS,

        season_renewal_lookback_days:
          SEASON_RENEWAL_LOOKBACK_DAYS,

        recent_episodes:
          recentEpisodes,

        recent_season_renewals:
          recentSeasonRenewals
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
        "3.0.0",

      monitoring:
        "TMDB new digital movie releases, new TV episodes, and TV season renewals (discover-based, not popular/trending lists)",

      movie_release_window:
        `${MOVIE_RELEASE_LOOKBACK_DAYS} days`,

      episode_release_window:
        `${EPISODE_LOOKBACK_DAYS} days`,

      season_renewal_window:
        `${SEASON_RENEWAL_LOOKBACK_DAYS} days`
    });
  }
);


/* =========================================================
   AUTOMATIC CHECK
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
