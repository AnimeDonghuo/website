# SoraBox

A production-minded, responsive catalog for **media you are authorized to distribute**. It has a polished public browsing experience and a private Telegram publisher workflow:

- **No media files live on Koyeb.** The bot copies uploads into a private Telegram database channel.
- **Every published poster is mirrored once to ImgBB** and the permanent hosted URL is saved to MongoDB. The catalog never fetches a poster on every page view.
- **Visitors get a Telegram deep link** (`https://t.me/<bot>?start=get-<code>`). After they tap **Start**, the bot copies that release's saved channel messages into their own chat.
- **MongoDB stores catalog metadata, file message references, delivery codes, and in-progress publisher drafts.** Sensitive channel and file references never leave the public API.
- A single Node service serves the React site, API, and Telegram long-polling bot — deliberately small enough for a Koyeb free instance.

> **Rights reminder:** only upload and deliver files you own or have explicit permission to distribute. Telegram and ImgBB each have their own content policies.

---

## What is included

### Public catalog

- Editorial dark-mode homepage, feature card, latest releases, category rail, and responsive mobile layout
- Categories for Anime, Cartoons, Donghua, K-Drama, Movies, and Web Series
- Search by title, genre, and language labels
- Dedicated details pages with metadata, tags, availability labels, related releases, and a polished Telegram delivery dialog
- Safe public API responses: no Telegram file IDs, database-channel IDs, or storage-message IDs are exposed
- A visual demo catalog appears automatically before MongoDB is configured, so the UI is immediately previewable

### Telegram publisher bot

- Publisher panel (`/panel`) plus fast category commands:
  - `/anime Title`
  - `/cartoon Title`
  - `/donghua Title`
  - `/kdrama Title`
  - `/movie Title`
  - `/series Title`
- Start a draft, send the title, upload files in the same private bot chat, then use `/done`
- Optional metadata commands: `/lang`, `/year`, `/genres`, `/description`, and `/poster`
- Automatic TMDB title/poster/synopsis matching when a TMDB key is configured
- Server-side poster download validation, then permanent ImgBB upload during publishing
- A generated PNG fallback poster is also uploaded to ImgBB if TMDB has no suitable match
- Files are copied to the Telegram database channel at upload time and delivered with `copyMessage` only after a valid deep link starts the bot
- Admin-only publishing using `TELEGRAM_ADMIN_IDS`; anyone else can only receive a delivery
- Draft sessions survive restarts when MongoDB is configured and expire automatically after 48 hours

---

## Architecture

```text
Admin in private bot chat
   │ /movie Title → upload files → /done
   ▼
Telegram bot ──copies media──► Private Telegram database channel
   │                                  │
   │ saves safe metadata               │ saved source message IDs
   ▼                                  ▼
MongoDB ◄──── SoraBox Node service ───┘
   │            │
   │            ├─ looks up title/poster from TMDB (optional)
   │            └─ mirrors poster once to ImgBB
   ▼
React catalog ──opens deep link──► Telegram bot ──copyMessage──► visitor chat
```

Koyeb only runs the website/API/bot process. It does not retain uploaded movies, episodes, or poster binaries.

---

## Local setup

### 1. Install

```bash
npm install
cp .env.example .env
npm run dev
```

- Vite client: `http://localhost:5173`
- API/server: `http://localhost:8000`
- Without `MONGODB_URI`, the app runs with a non-persistent visual demo catalog. This is intentional for design previews only.

For a production-shaped local run, first build then start the unified server:

```bash
npm run build
npm start
```

Health check:

```bash
curl http://localhost:8000/api/health
```

### 2. Configure MongoDB

Create a MongoDB Atlas free cluster (or another MongoDB deployment) and set:

```dotenv
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/sorabox?retryWrites=true&w=majority
MONGODB_DB=sorabox
```

The app creates its indexes automatically. `content` stores published catalog records; `upload_sessions` stores short-lived publisher drafts.

### 3. Configure Telegram

1. Create a bot with **@BotFather** and save the token privately.
2. Create a **private** Telegram channel to be your database channel.
3. Add the bot to that channel as an administrator with permission to post messages. Do not turn on channel-level protections that prevent the bot from copying your own messages.
4. Find the channel's numeric ID (usually starts with `-100`) and your own numeric Telegram user ID.
5. Configure these server-only values:

```dotenv
TELEGRAM_BOT_TOKEN=your_botfather_token
TELEGRAM_BOT_USERNAME=YourBotUsernameWithoutTheAtSign
TELEGRAM_STORAGE_CHANNEL_ID=-1001234567890
TELEGRAM_ADMIN_IDS=123456789,987654321
TELEGRAM_MODE=polling
```

`TELEGRAM_ADMIN_IDS` is important: if it is empty, nobody can publish. Use a comma-separated allowlist of numeric Telegram user IDs, not usernames.

### 4. Configure permanent ImgBB posters

Set your ImgBB server API key as **`IMGBB_API_KEY`**. It is used only by server-side publishing code. Do **not** commit it, put it in a `VITE_` variable, or paste it into client code.

```dotenv
IMGBB_API_KEY=your_imgbb_server_key
```

At `/done`, the server does this once:

1. Uses the selected/manual/TMDB poster if available.
2. Validates the source is a public HTTPS image and limits it to 8 MB.
3. Uploads a copy to ImgBB.
4. Saves only the hosted ImgBB URL and non-sensitive provider metadata in MongoDB.

If automatic matching finds no poster, SoraBox generates a branded fallback PNG and uploads that to ImgBB instead. This keeps the poster path hosted externally and avoids loading Koyeb storage.

### 5. Optional: enable automatic TMDB metadata

Create a TMDB API key or read-access token and configure one of:

```dotenv
TMDB_API_KEY=your_tmdb_api_key
# or
TMDB_READ_ACCESS_TOKEN=your_tmdb_read_access_token
```

TMDB is optional. Without it, publisher-entered titles still work and receive a permanent ImgBB fallback poster. With it, the bot tries to populate the canonical title, year, synopsis, genre labels, and poster source before publishing.

---

## Publishing through Telegram

The shortest workflow is exactly this:

```text
/movie Red Sand Signal
[upload one or more files]
/done
```

Or use a guided title step:

```text
/cartoon
Pocket Planet
[upload one or more files]
/lang Hindi, English
/genres Family, Adventure
/done
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `/panel` | Open category buttons and draft controls |
| `/anime`, `/cartoon`, `/donghua`, `/kdrama`, `/movie`, `/series` | Start a category draft; title may follow the command |
| `/title Title` | Replace a draft title and re-run metadata lookup |
| `/lang Hindi, English` | Set public language labels |
| `/year 2026` | Set the release year |
| `/genres Action, Fantasy` | Set public genre labels |
| `/description …` | Set a public synopsis |
| `/poster https://…` | Override automatic artwork with a public HTTPS image |
| `/status` | See the active draft state |
| `/cancel` | Discard the active draft |
| `/done` | Mirror the poster, create the MongoDB record, and return the share link |

When publishing succeeds, the bot replies with a URL like:

```text
https://t.me/YourBotUsername?start=get-7kWJdR7oTg
```

Put that generated URL behind the site's **Get files on Telegram** button. The public site builds it from the record's short delivery code, and the bot resolves it privately. The user never sees the storage channel or raw Telegram file IDs.

---

## Deploy to Koyeb (free tier friendly)

This repo includes a multi-stage `Dockerfile`. It builds the client once, then runs only the lean Node process on port `8000`.

1. Push this repository to GitHub.
2. In Koyeb, create a **Web Service** from that repository.
3. Choose **Dockerfile** as the builder and select `Dockerfile` at the repository root.
4. Expose **port `8000`** with the HTTP protocol and route `/` to it.
5. Set health check path to **`/api/health`**.
6. Use **one replica only**. Telegram long polling must have exactly one active bot consumer.
7. Add the environment variables below and deploy.

| Variable | Koyeb type | Required | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | Plaintext | Yes | `production` |
| `PORT` | Plaintext | Yes | `8000` |
| `MONGODB_URI` | Secret | Yes | Mongo connection string |
| `MONGODB_DB` | Plaintext | No | Defaults to `sorabox` |
| `IMGBB_API_KEY` | Secret | Yes | Never expose it to the browser |
| `TELEGRAM_BOT_TOKEN` | Secret | Yes | BotFather token |
| `TELEGRAM_BOT_USERNAME` | Plaintext | Yes | No leading `@` |
| `TELEGRAM_STORAGE_CHANNEL_ID` | Secret or plaintext | Yes | Private channel numeric ID |
| `TELEGRAM_ADMIN_IDS` | Secret or plaintext | Yes | CSV numeric admin IDs |
| `TELEGRAM_MODE` | Plaintext | Yes | `polling` |
| `TMDB_API_KEY` or `TMDB_READ_ACCESS_TOKEN` | Secret | Recommended | Enables automatic metadata/posters |

Koyeb's default route/port conventions also recognize port 8000, but setting it explicitly makes the service configuration clear. Keep the bot token, ImgBB key, TMDB credential, and MongoDB URI in Koyeb's secret store rather than in Git.

### Why it fits a small Koyeb instance

- React assets are built during the Docker build, then served as static files with compression.
- The server does not store poster files or media files on its disk.
- ImgBB work happens once per publishing event rather than on every catalog request.
- Media delivery is Telegram-to-Telegram; Koyeb only handles small metadata/API requests.
- MongoDB Atlas free tier can hold the catalog records and bot draft state.

---

## API

All public API routes are same-origin and read-only:

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Deployment health and non-sensitive store status |
| `GET /api/config` | Public category/configuration flags |
| `GET /api/categories` | Category labels and current counts |
| `GET /api/content` | Latest catalog records |
| `GET /api/content?category=anime` | Filter by category |
| `GET /api/content?q=title` | Search title, genres, or languages |
| `GET /api/content/featured` | Current featured record |
| `GET /api/content/:slug` | One public catalog record |

The API intentionally omits `telegramFileId`, `storageMessageId`, channel ID, and any provider deletion URL.

---

## Quality checks

```bash
npm run build
npm test
# or both
npm run check
```

Before production, test the full Telegram path with a harmless file you own: publish it, open the returned deep link from another Telegram account, and confirm the bot can copy it from the private channel.
