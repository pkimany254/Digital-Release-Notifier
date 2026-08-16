# Movie & Series Release Notifier

A Telegram bot that monitors popular and trending movies and TV series using **TMDB** and sends notifications when:

* 🎬 A popular/trending movie receives a **recent digital release**
* 📺 A popular/trending TV series has a **newly aired episode**

The bot is designed to run continuously on a server such as **Railway**.

---

## ✨ Features

### 🎬 Movie Release Notifications

The bot monitors popular and trending movies on TMDB and checks their release information.

It only considers **digital releases from the last 7 days**, preventing old digital releases from being reported as new.

Example:

> 🔔 NEW DIGITAL RELEASE
>
> 🎬 The Furious (2026)
>
> 💿 Digital release available
> 📅 14 Aug 2026

### 📺 TV Episode Notifications

The bot monitors popular and trending TV series and checks for recently aired episodes.

Episodes from the last **7 days** are considered.

The bot filters out several types of TV content that aren't intended for the notifier, including:

* Reality
* Documentary
* News
* Soap
* Talk shows
* Animation

Example:

> 📺 NEW EPISODE
>
> 🎬 Silo
> S03E07 — Radio
>
> 📅 13 Aug 2026

### 🔔 Telegram Notifications

Notifications are sent directly to a configured Telegram chat.

### 🛡️ Duplicate Protection

The bot stores previously notified movies and episodes in a SQLite database.

This prevents the same release or episode from being sent repeatedly.

The database is stored on the persistent `/data` volume so notification history survives application restarts and redeployments.

### 🔄 Automatic Monitoring

The bot automatically performs a release check every **6 hours**.

It also performs an initial check shortly after the server starts.

---

## 🧩 How It Works

```text
                    TMDB
                     │
          ┌──────────┴──────────┐
          │                     │
     Popular Movies        Popular TV
          │                     │
     Trending Movies       Trending TV
          │                     │
          ▼                     ▼
   Recent Digital          Filter unwanted
      Release?             TV categories
          │                     │
          ▼                     ▼
      Notify                 Recent
      Telegram               Episodes?
                                │
                                ▼
                             Notify
                             Telegram
```

Before sending a notification, the bot checks its SQLite database to make sure that release or episode has not already been notified.

---

## 🛠️ Requirements

* Node.js
* TMDB API key
* Telegram bot
* Telegram chat ID
* SQLite
* Persistent storage for `/data`

---

## 📦 Installation

Clone the repository:

```bash
git clone YOUR_REPOSITORY_URL
cd movie-series-release-notifier
```

Install dependencies:

```bash
npm install
```

Start the server:

```bash
node server.js
```

---

## 🔐 Environment Variables

The application requires the following environment variables:

| Variable             | Description                                               |
| -------------------- | --------------------------------------------------------- |
| `TMDB_API_KEY`       | TMDB API key                                              |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token                                        |
| `TELEGRAM_CHAT_ID`   | Telegram chat ID                                          |
| `PORT`               | Server port; Railway normally provides this automatically |

Example:

```env
TMDB_API_KEY=your_tmdb_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

**Never commit your API keys or Telegram bot token to GitHub.**

Use environment variables or your hosting provider's secret/environment-variable settings.

---

## 🚂 Railway Deployment

The bot can be deployed on Railway.

### 1. Create a Railway project

Create a new Railway project and deploy the GitHub repository.

### 2. Add environment variables

Add:

```text
TMDB_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

### 3. Add persistent storage

Create a Railway Volume and mount it at:

```text
/data
```

The application stores its SQLite database at:

```text
/data/watchlist.db
```

The persistent volume is important because the database contains the history of notifications already sent.

Without persistent storage, the bot could lose its notification history after a restart or redeployment.

---

## 🔗 API Endpoints

### Health Check

```text
GET /
```

Returns basic information about the running service.

Example:

```json
{
  "status": "ok",
  "service": "movie-series-release-notifier",
  "version": "2.1.0"
}
```

---

### Run a Full Check

```text
GET /run-all
```

Manually runs both:

* Movie release checks
* TV episode checks

Example response:

```json
{
  "success": true,
  "movies": {
    "total": 30,
    "checked": 30,
    "recent_digital_releases": 2,
    "notified": 2,
    "already_notified": 0,
    "errors": 0
  },
  "shows": {
    "total": 30,
    "checked": 30,
    "eligible_shows": 25,
    "filtered": 5,
    "available_episodes": 1,
    "notified": 1,
    "already_notified": 0,
    "errors": 0
  }
}
```

---

### Check Status

```text
GET /status
```

Returns the status of the current or most recent check.

Example:

```json
{
  "success": true,
  "check_in_progress": false,
  "last_check": {
    "started_at": "...",
    "finished_at": "...",
    "movies": {},
    "shows": {},
    "error": null
  }
}
```

---

### Test a Movie

```text
GET /test-movie/:tmdbId
```

Example:

```text
/test-movie/157336
```

This checks whether the movie currently has a recent digital release according to the bot's 7-day release window.

---

### Test a TV Show

```text
GET /test-show/:tmdbId
```

Example:

```text
/test-show/125988
```

This checks whether the TV show is eligible and returns its recently aired episodes.

---

## ⚙️ Current Monitoring Rules

### Movies

The bot currently:

1. Gets popular movies from TMDB.
2. Gets weekly trending movies.
3. Combines the results.
4. Removes animated titles.
5. Sorts them by popularity.
6. Checks their TMDB release dates.
7. Looks specifically for **Digital releases (TMDB release type 4)**.
8. Only accepts releases from the last **7 days**.
9. Checks the database for previous notifications.
10. Sends a Telegram notification for new releases.

### TV Shows

The bot currently:

1. Gets popular TV shows from TMDB.
2. Gets weekly trending TV shows.
3. Combines the results.
4. Sorts them by popularity.
5. Retrieves detailed show information.
6. Filters unwanted categories.
7. Checks the latest seasons.
8. Looks for episodes aired within the last **7 days**.
9. Checks the database for previous notifications.
10. Sends a Telegram notification for new episodes.

---

## 🗃️ Database

The application uses SQLite.

Database location:

```text
/data/watchlist.db
```

Two notification tables are used:

### Movies

```text
popular_movie_notifications
```

Stores movies that have already triggered a notification.

### Episodes

```text
popular_episode_notifications
```

Stores individual TV episodes that have already triggered a notification.

Each episode is identified by:

```text
TMDB ID + Season + Episode
```

This ensures that individual episodes are only notified once.

---

## ⏱️ Automatic Checks

The bot runs automatically every:

```text
6 hours
```

It also performs an initial check approximately:

```text
15 seconds
```

after startup.

This means no manual `/run-all` request is required during normal operation.

---

## 📁 Project Structure

```text
movie-series-release-notifier/
│
├── server.js
├── package.json
├── package-lock.json
├── README.md
└── ...
```

The SQLite database is intentionally stored outside the project directory on the persistent `/data` volume.

---

## 🔒 Security

Do not publish:

* TMDB API keys
* Telegram bot tokens
* Telegram chat IDs where they should remain private
* Database files containing private notification history

Store secrets using environment variables.

---

## 📝 Current Scope

The notifier currently focuses on **public TMDB popularity/trending data**, rather than individual users' watchlists.

Simkl watchlist and "currently watching" functionality was explored during development but is not required by the current notification system.

The current goal is simple:

> **Notify when a popular movie gets a recent digital release or when a popular series receives a new episode.**

---

## 🚀 Future Improvements

Possible future improvements include:

* Better movie popularity filtering
* More precise TV-series filtering
* Customizable notification windows
* Separate movie and TV notification settings
* TMDB links in Telegram notifications
* Poster images in Telegram notifications
* Genre preferences
* Country-specific release detection
* Configurable check intervals
* User-specific notification preferences
* Additional notification platforms

---

## 📄 License

Add the project's preferred license here.

For example:

```text
MIT License
```

---

## 🙏 Credits

Movie and TV metadata and release information are provided by [TMDB](https://www.themoviedb.org/).

Telegram is used for delivering notifications.

Built as a lightweight automated release-monitoring service.
