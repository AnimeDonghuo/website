# SoraBox

A production-minded, responsive catalog for **media you are authorized to distribute**. It has a polished public browsing experience and a private Telegram publisher workflow:

- **No media files live on Koyeb.** The bot copies uploads into a private Telegram database channel.
- **Every published poster is mirrored once to ImgBB** and the permanent hosted URL is saved to MongoDB. The catalog never fetches a poster on every page view.
- **Visitors get a Telegram deep link** (`https://t.me/<bot>?start=get-<code>`). After they tap **Start**, the bot copies that release's saved channel messages into their own chat.
- **MongoDB stores catalog metadata, file message references, delivery codes, in-progress publisher/request-selection drafts, and private aggregate analytics.** Sensitive channel and file references never leave the public API.
- A single Node service serves the React site, API, and Telegram long-polling bot — deliberately small enough for a Koyeb free instance.

> **Rights reminder:** only upload and deliver files you own or have explicit permission to distribute. Telegram and ImgBB each have their own content policies.

---

## What is included

### Public catalog

- Editorial dark-mode homepage, feature card, latest releases, category rail, and responsive mobile layout
- Categories for Anime, Cartoons, Donghua, K-Drama, Movies, and Web Series
- Search by title, genre, and language labels
- Dedicated details pages with metadata, tags, availability labels, a smart episode index whose cards open episode-specific delivery pages, related releases, individual file/quality delivery choices, and a polished all-files Telegram delivery dialog. Episode-based releases intentionally keep quality/file choices inside the selected-episode page instead of showing a confusing all-release picker.
- Search that supports multi-word title, genre, and language matching
- Safe public API responses: no Telegram file IDs, database-channel IDs, storage-message IDs, or delete-only post IDs are exposed
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
- Category-aware metadata fallback chain: AniList for Anime/Donghua, TMDB, then OMDb when configured
- Server-side poster download validation, then permanent ImgBB upload during publishing
- A generated category-colored PNG fallback poster **renders the release title** and is uploaded to ImgBB if no provider has suitable artwork
- Smart episode parser: cleans captions first, removes `@channel` / `t.me` attribution, recognizes `EP 01`, `Episode 1 To 5`, and `S01E01-E05`, then falls back to the filename
- Upload captions/file names also resolve explicit language labels. For example, `Multi (Hindi + Malayalam)` is published as **Hindi** and **Malayalam**, never the unhelpful generic `Multi language` label
- Post pages show a safe, public episode index; each episode/range card opens a dedicated page containing every matching file-quality delivery link, while storage message IDs remain private
- Files are copied to the Telegram database channel at upload time and delivered with `copyMessage` only after a valid deep link starts the bot
- `/batch Optional title` imports an inclusive existing `t.me/c/<internal-channel-id>/<message-id>` range from that private database channel as **one release**, including long runs such as 448 episode messages. It preserves original storage message IDs, retries Telegram rate limits, reports progress, infers title/category when no name is supplied, and enumerates every already-published, active-draft, non-media, inaccessible, or protected message ID instead of reporting a vague skip count
- `/auto` presents persistent ON/OFF controls; when ON, direct database-channel media is collected by normalized release title for 90 seconds of quiet (15-minute maximum), then classified, provider-verified, poster-mirrored, and published as one combined post. Provider identity and cleaned aliases are retained so later noisy title variants append to the same post without a duplicate announcement
- Auto completion/failure reports are delivered to the authorized publisher's bot chat, including the private `SB-…` ID, while database-channel error replies are suppressed
- Publisher controls are locked behind `/login <passcode>` and can also be restricted by `TELEGRAM_ADMIN_IDS`
- Public `/request` messages are stored in MongoDB and mirrored into the private request/database channel; `/requests` opens a multi-select publisher workflow that marks selected requests **Completed** or **Rejected** and immediately notifies each requester
- Unlimited announcement channels can be managed with `/addchannel`; each new post gets a professional poster, metadata card, and website detail-page button
- Every post receives a private `SB-…` Post ID; `/posts 50` lists recent IDs, `/postid` filters IDs and names by Today/Yesterday/Week/Month, and `/delete SB-…` can remove one or several unwanted catalog cards
- `/stats` reports private aggregate bot activity, anonymous site visitors/visits, catalog totals, and request status totals. Site tracking uses only a random first-party visitor cookie—never raw IPs or public Telegram data
- Draft/login/request-selection sessions survive restarts when MongoDB is configured and expire automatically

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
   │            ├─ looks up title/poster via AniList → TMDB → OMDb fallbacks
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

### Public website URL for Telegram announcements

Set the externally reachable catalog URL before publishing announcement posts:

```dotenv
PUBLIC_SITE_URL=https://your-catalog.koyeb.app
```

Telegram announcement buttons use this URL and open `/<category>/<slug>` on your website. Visitors can review the title, individual file/quality choices, and episode guide there before tapping a Telegram delivery button. The announcement channel never receives the direct Telegram file link.

After changing a Koyeb environment value, redeploy the active service revision. Its startup log prints `Announcement site URL: …`, and `https://your-catalog.koyeb.app/api/health` exposes the non-sensitive `announcementSiteUrl` value. If it is `null`, the running revision did not receive a usable URL. The parser accepts a normal full URL, a quoted URL, or a bare Koyeb hostname, and also recognizes common aliases such as `WEBSITE_URL`, `SITE_URL`, and `KOYEB_PUBLIC_DOMAIN`; use `PUBLIC_SITE_URL` as the canonical setting. Previously sent Telegram posts cannot be changed retroactively.

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
3. Add the bot to that channel as an administrator with permission to post messages. For `/batch`, it must also be able to forward existing messages from that exact channel. Do not turn on channel-level protections that prevent the bot from copying/forwarding your own messages.
4. Keep the bot in that channel so Telegram can deliver `channel_post` updates when `/auto` is enabled; the same bot must own the configured token.
5. Find the channel's numeric ID (usually starts with `-100`) and your own numeric Telegram user ID.
6. Configure these server-only values:

```dotenv
TELEGRAM_BOT_TOKEN=your_botfather_token
TELEGRAM_BOT_USERNAME=YourBotUsernameWithoutTheAtSign
TELEGRAM_STORAGE_CHANNEL_ID=-1001234567890
# Optional separate private channel for user requests; otherwise storage channel is used.
TELEGRAM_REQUEST_CHANNEL_ID=-1001234567890
# Optional allowlist. If set, only these IDs may successfully use /login.
TELEGRAM_ADMIN_IDS=123456789,987654321
# Required publisher passcode; set your desired value as a Koyeb secret (for example, AYU).
ADMIN_LOGIN_CODE=your_private_publisher_passcode
ADMIN_SESSION_HOURS=24
TELEGRAM_MODE=polling
```

`ADMIN_LOGIN_CODE` is required to unlock publishing. A logged-in publisher session expires automatically after the configured number of hours. `TELEGRAM_ADMIN_IDS` is an optional additional safety layer: when it is populated, only those numeric Telegram user IDs can log in even if somebody knows the passcode. When it is empty, the passcode itself controls access.

#### Bot-token rotation and replacement recovery

Delivery URLs are **not stored with a bot username** in MongoDB. Catalog buttons use stable first-party `/deliver/...` URLs, which redirect to the currently active Telegram bot at click time. When a token is rotated, deploy the new `TELEGRAM_BOT_TOKEN`; at launch, the service asks Telegram which `@username` owns that token and uses it for all catalog and per-file links automatically. This also handles a replacement bot with a different username — update the token, redeploy, and add the replacement bot as an administrator of the existing private storage channel so it can copy the saved messages.

Check `/api/health` after deployment: `deliveryBotUsername` must be the replacement bot. Existing catalog pages, their file buttons, and website-first announcement buttons will then resolve to it. A previously copied external `t.me/OldBot?...` URL cannot be rewritten after the old bot is banned; share the stable catalog page or its `/deliver/...` link rather than old direct links when recovering.

#### Storage-channel troubleshooting

Use the channel's **numeric** ID (normally `-100…`), not its invite link. The bot must be an administrator with **Post Messages** enabled. SoraBox first uses Telegram `copyMessage`; if Telegram refuses a copied/forwarded file, it automatically retries by sending the file ID in its original type. If Telegram says the source is protected, send the original file directly to your bot instead of forwarding it from a protected channel. `/batch` only accepts a private `t.me/c/...` link whose internal ID maps exactly to `TELEGRAM_STORAGE_CHANNEL_ID`; it temporarily forwards each requested message into the logged-in publisher’s private chat to inspect it, then deletes that preview. Its final report names every inaccessible/protected, non-media, already-published, and active-draft message ID and reason. If a previous broken auto run already created one-file cards, those IDs are deliberately reported as already linked; use `/posts 50`, remove the unwanted cards with `/delete`, then rerun `/batch` to build one clean post.

### 4. Configure permanent ImgBB posters

Set your ImgBB server API key as **`IMGBB_API_KEY`**. It is used only by server-side publishing code. Do **not** commit it, put it in a `VITE_` variable, or paste it into client code.

```dotenv
IMGBB_API_KEY=your_imgbb_server_key
```

At `/done`, the server does this once:

1. Uses the selected/manual/AniList/TMDB/OMDb poster if available.
2. Validates the source is a public HTTPS image and limits it to 8 MB.
3. Uploads a copy to ImgBB.
4. Saves only the hosted ImgBB URL and non-sensitive provider metadata in MongoDB.

If automatic matching finds no poster, SoraBox generates a branded category-colored fallback PNG **with the release title rendered on it** and uploads that to ImgBB instead. This keeps the poster path hosted externally, recognizable in the catalog, and avoids loading Koyeb storage.

### 5. Optional: enable automatic metadata and artwork matching

SoraBox uses a category-aware fallback chain before it generates a fallback poster:

1. **AniList** for Anime and Donghua — public GraphQL, no API key needed.
2. **TMDB** for Movies, K-Drama, Cartoons, Web Series, and as an animation fallback.
3. **OMDb** as a movie/series fallback if TMDB has no usable result.

Provider candidates are title-scored before their names, IDs, or posters are used. This prevents a popular but unrelated first search result from naming a release or supplying the wrong poster; when no provider result is confident enough, SoraBox uses the cleaned upload title and its branded fallback artwork instead.

Configure TMDB and/or OMDb for the fullest coverage:

```dotenv
TMDB_API_KEY=your_tmdb_api_key
# or
TMDB_READ_ACCESS_TOKEN=your_tmdb_read_access_token
OMDB_API_KEY=your_omdb_api_key
```

The first confident provider result supplies the canonical title, year, synopsis, genres, language labels where available, and poster source. The source image is still copied to ImgBB at publishing time. If every provider misses, publishing continues with the publisher-entered title and a generated ImgBB-hosted poster.

---

## Publishing through Telegram

A normal user sees a welcome screen plus `/request`. Publisher commands are unavailable until they unlock a session:

```text
/login your_private_publisher_passcode
/movie Red Sand Signal
[upload one or more files]
/done
```

Or use the guided title step:

```text
/login your_private_publisher_passcode
/cartoon
Pocket Planet
[upload one or more files]
/lang Hindi, English
/genres Family, Adventure
/done
```

For episode-based posts, use a descriptive media caption such as `Perfect World @yourchannel — Ep 1 To 5`. The parser removes the Telegram attribution and checks this caption before trying the filename. It recognizes individual episodes and episode ranges, then renders a safe episode guide on the public post page.

Useful commands:

| Command | Purpose |
| --- | --- |
| `/request Perfect World Hindi` | Public command: send a request to MongoDB and the private request/database channel |
| `/login passcode` / `/logout` | Unlock or end the expiring publisher session |
| `/panel` | Open category buttons and draft controls after login |
| `/anime`, `/cartoon`, `/donghua`, `/kdrama`, `/movie`, `/series` | Start a category draft; title may follow the command |
| `/batch Optional title` | Import an inclusive first/last `t.me/c/...` range from the configured private storage channel; omit title to infer it, or use `category \| title` to override category |
| `/auto` | Show persistent ON/OFF controls for direct database-channel auto-publishing |
| `/title Title` | Replace a draft title and re-run provider lookup |
| `/lang Hindi, English` | Set public language labels |
| `/year 2026` | Set the release year |
| `/genres Action, Fantasy` | Set public genre labels |
| `/description …` | Set a public synopsis |
| `/poster https://…` | Override automatic artwork with a public HTTPS image |
| `/status` | See the active draft state and detected episode index |
| `/teststorage` | Send a harmless test message to verify the configured database channel |
| `/cancel` | Discard the active draft |
| `/done` | Mirror poster, create MongoDB record, announce to every configured channel, and return share + Post ID |
| `/posts 50` | List recent private `SB-…` post IDs for cleanup or management |
| `/postid` | Open Today, Yesterday, Week, and Month buttons to return uploaded post IDs with names for that period (IST) |
| `/stats` | Show anonymous site-visitor/visit activity, private bot-user activity, catalog totals, and request status totals |
| `/delete SB-0123ABCDEF[, SB-FEDCBA3210]` | Remove one or several published catalog records and disable their deep links |
| `/addchannel -1001234567890` | Add a channel for automatic professional new-post announcements |
| `/channels` / `/removechannel ID` | View or remove announcement destinations |
| `/requests` | Open Select requests / Back controls, multi-select open requests, then mark selected requests Completed or Rejected; each requester is notified immediately |

When `PUBLIC_SITE_URL` is configured, publishing returns the stable catalog detail-page URL as the recommended share link, plus a private all-files Telegram button for the publisher. Without a website URL, it falls back to a direct link like:

```text
https://t.me/YourBotUsername?start=get-7kWJdR7oTg
```

The public site creates a stable all-files `/deliver/<code>` action and a separate `/deliver/<code>/file/<position>` action for every uploaded file. Each routes to the current bot's Telegram deep link only when clicked, so a bot replacement does not require a catalog migration. The detail page displays cleaned file labels, detected quality, size, and episode/range information so visitors can choose exactly one delivery option or request all files. A successful publish also returns a private `SB-…` Post ID for `/delete`. The user never sees the storage channel, raw Telegram file IDs, or that deletion ID.

### Import an existing private storage range

Use this when the files are already in the configured private database channel and should not be copied into a second storage message:

```text
/batch Perfect World
https://t.me/c/2617067511/9335
https://t.me/c/2617067511/9342
```

The first and last links define an **inclusive** message-ID range. The bot validates that both links map to the configured `TELEGRAM_STORAGE_CHANNEL_ID`, processes every supported message in that one range (including long 448-message episode runs), preserves each original storage message ID, retries Telegram flood/rate-limit responses, gives periodic progress updates, skips non-media/protected/inaccessible/already-published items, then performs the normal metadata, ImgBB poster, catalog, and announcement workflow. It never exposes the private-channel ID or raw file IDs on the public site.

A name is optional:

```text
/batch
https://t.me/c/2617067511/9335
https://t.me/c/2617067511/9342
```

In that case, cleaned file captions/descriptions and names supply the title and category. Episode-detected ranges become Web Series by default; explicit title/file signals such as `Donghua`, `Anime`, `K-Drama`, or `Cartoon` choose their matching category, and Chinese/Japanese/Korean episode labels provide Donghua/Anime/K-Drama fallbacks. If a title needs a deterministic category, use an optional prefix such as `/batch donghua | Perfect World`.

### Manage requests, post IDs, and publisher analytics

Run `/requests` in an unlocked publisher chat to open a first screen with **Select requests** and **Back**. Select requests opens a paginated checklist of open requests; tap any number of items, then press **Completed** or **Rejected**. The selected records are updated in MongoDB before notifications are sent. Completed requesters receive a message asking them to kindly check the site; rejected requesters are told the request was rejected due to issues.

Run `/postid` and choose **Today**, **Yesterday**, **Week**, or **Month** to receive uploaded private `SB-…` IDs paired with their post names. These calendar filters use India Standard Time. Run `/stats` for aggregate catalog/file/episode/Telegram-delivery totals, open/completed/rejected requests, anonymous site visitor/visit counts and recent activity, plus private bot-user counts and activity. Site analytics stores a random first-party identifier and page path only; it does not record raw IP addresses, query strings, or public Telegram identities.

### Automatically publish direct database-channel uploads

After logging in, run `/auto` and press **Turn ON**. The ON/OFF setting, authorized publisher notification chat, and pending upload groups are stored in MongoDB, so they survive Koyeb restarts. While enabled, a newly posted document, video, audio, animation, or photo in the configured database channel is inspected directly in that channel and assigned a normalized release key.

Matching files are collected for **90 seconds after the latest matching upload** (with a **15-minute maximum** for an uninterrupted large upload). One group can contain 100+ files. When its deadline is reached, the bot infers title/category, title-scores TMDB/OMDb/AniList candidates, mirrors one permanent verified/fallback poster to ImgBB, creates one catalog post, and sends one announcement. The raw cleaned key, canonical provider title, and provider identity are saved together; a later upload with an alias/noisy name can therefore append to the same record and is not announced again. Completion notices include the `SB-…` Post ID and go to the publisher's private bot chat; errors are logged and reported there rather than being replied into the private database channel. An interrupted in-flight group is safely released for retry when the single Koyeb service starts again.

Name cleanup ignores dotted/underscore release separators, file extensions, years, quality/provider/codec/audio tags, bracketed release labels, Telegram handles, Markdown links, and ordinary URLs. For example, `Cocktail.2.2026.1080p.NF.WEB-DL.Hindi.DDP5.1.H.265~[C_B].mkv` becomes **Cocktail 2**, while `Raakh.S01E03.1080p.AMZN` becomes **Raakh** and is recognized as episode-based Web Series content. A weak/unrelated provider search result is rejected rather than being used as the post name or poster.

The automation ignores bot-originated storage copies, any message already attached to an active draft, and storage message IDs already present in a published catalog record. This prevents normal manual uploads and announcement activity from being duplicated or causing a loop. Keep the storage channel private and use `/auto` OFF before bulk housekeeping; use `/batch` for an intentional historical range.

### Automatic announcement channels

After logging in, add every destination where you want polished new-release cards to appear:

```text
/addchannel -1001234567890
/addchannel -1009876543210
/channels
```

The bot verifies that the target is a Telegram channel it can access, stores it in MongoDB, and then sends every future published item to every saved channel. The private database channel itself is intentionally rejected as an announcement destination so `/auto` cannot loop on its own announcement poster. Each announcement includes the permanent ImgBB poster, category/title/metadata, episode or file summary, synopsis, and a **View on Website** button. Set `PUBLIC_SITE_URL` to your Koyeb domain so that button opens the public detail page rather than a direct Telegram file link. Use `/removechannel <channel_id>` to stop future announcements. The bot needs administrator rights in each destination channel.

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
| `PUBLIC_SITE_URL` | Plaintext | Yes | Your canonical Koyeb site URL; announcement buttons open the post page here |
| `MONGODB_URI` | Secret | Yes | Mongo connection string |
| `MONGODB_DB` | Plaintext | No | Defaults to `sorabox` |
| `IMGBB_API_KEY` | Secret | Yes | Never expose it to the browser |
| `TELEGRAM_BOT_TOKEN` | Secret | Yes | BotFather token |
| `TELEGRAM_BOT_USERNAME` | Plaintext | Yes | No leading `@` |
| `TELEGRAM_STORAGE_CHANNEL_ID` | Secret or plaintext | Yes | Private channel numeric ID |
| `TELEGRAM_REQUEST_CHANNEL_ID` | Secret or plaintext | No | Separate private request channel; defaults to storage channel |
| `ADMIN_LOGIN_CODE` | Secret | Yes | Publisher passcode; use your chosen value, not a client variable |
| `ADMIN_SESSION_HOURS` | Plaintext | No | Defaults to `24` |
| `TELEGRAM_ADMIN_IDS` | Secret or plaintext | No | Optional CSV numeric login allowlist |
| `TELEGRAM_MODE` | Plaintext | Yes | `polling` |
| `TMDB_API_KEY` or `TMDB_READ_ACCESS_TOKEN` | Secret | Recommended | Enables broader automatic metadata/posters |
| `OMDB_API_KEY` | Secret | Optional | Movie/series metadata fallback |

Koyeb's default route/port conventions also recognize port 8000, but setting it explicitly makes the service configuration clear. Keep the bot token, publisher passcode, ImgBB key, TMDB/OMDb credentials, and MongoDB URI in Koyeb's secret store rather than in Git.

### Why it fits a small Koyeb instance

- React assets are built during the Docker build, then served as static files with compression.
- The server does not store poster files or media files on its disk.
- ImgBB work happens once per publishing event rather than on every catalog request.
- Media delivery is Telegram-to-Telegram; Koyeb only handles small metadata/API requests.
- MongoDB Atlas free tier can hold the catalog records and bot draft state.

---

## API

All public API routes are same-origin and read-only. The two same-origin delivery routes below redirect to Telegram:

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Deployment health, non-sensitive store status, active delivery-bot username, and normalized announcement URL |
| `GET /api/config` | Public category/configuration flags |
| `GET /api/categories` | Category labels and current counts |
| `GET /api/content` | Latest catalog records |
| `GET /api/content?category=anime` | Filter by category |
| `GET /api/content?q=title` | Search title, genres, or languages |
| `GET /api/content/featured` | Current featured record |
| `GET /api/content/:slug` | One public catalog record |
| `GET /deliver/:shareCode` | Stable redirect to the active bot’s all-files Telegram delivery deep link |
| `GET /deliver/:shareCode/file/:position` | Stable redirect to the active bot’s selected-file Telegram delivery deep link |

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
