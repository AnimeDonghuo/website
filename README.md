# SoraBox

A production-minded, responsive catalog for **media you are authorized to distribute**. It has a polished public browsing experience and a private Telegram publisher workflow:

- **No media files live on Koyeb.** The bot copies uploads into a private Telegram database channel.
- **Every published poster is mirrored once to ImgBB** and the permanent hosted URL is saved to MongoDB. The catalog never fetches a poster on every page view.
- **Visitors get a Telegram deep link** (`https://t.me/<bot>?start=get-<code>`). After they tap **Start**, the bot copies that release's saved channel messages into their own chat and schedules each bot-delivered file message for best-effort removal after five minutes. This removes the chat message only—it cannot recall a file the recipient has already downloaded, saved, or forwarded.
- **MongoDB stores catalog metadata, file message references, delivery codes, in-progress publisher/request-selection drafts, and private aggregate analytics.** Sensitive channel and file references never leave the public API. Signed, compressed application backups can be sent to the private storage channel and restored into a replacement MongoDB database.
- A single Node service serves the React site, API, and Telegram long-polling bot — deliberately small enough for a Koyeb free instance.

> **Rights reminder:** only upload and deliver files you own or have explicit permission to distribute. Telegram and ImgBB each have their own content policies.

---

## What is included

### Public catalog

- Editorial dark-mode homepage, feature card, latest releases, category rail, and responsive mobile layout
- Categories for Anime, Cartoons, Donghua, K-Drama, Movies, Web Series, **TV & OTT**, and **18+**. *TV & OTT* is the shelf for what is neither an anime, a donghua, a K-Drama, nor a theatrical film: broadcast shows, streaming originals, and OTT premieres (`India's Got Latent`, a Saturday-night talk show, a game show). Publishers call it TV as often as OTT, so `tv`, `ott`, `tv show`, `television`, `streaming`, and `broadcast` all resolve to that one category everywhere a category is typed. The homepage “Choose a universe” rail deliberately lists only the seven general categories; **18+** stays reachable through the menu (mobile drawer) and the browse/category navigation, so restricted material is never presented on the front page by default
- The 18+ area displays an explicit age-confirmation prompt before the browser requests any restricted cards, details, Watch pages, episode pages, or Telegram delivery redirect; ordinary home, search, featured, and all-catalog APIs never include restricted records
- Search by title, **episode number**, genre, and language labels, from a field that lives in the header at every screen size: the full pill on a wide screen, a search icon that slides a strip out under the header on a narrow one, and ⌘/Ctrl-K to focus the field wherever it is shown
- **Day and Night themes.** A `Day`/`Night` button in the header switches the whole site between its dark theme and a white one, the choice is remembered per visitor, and a returning visitor's theme is applied before the page paints, so there is no flash of black. Night stays the default for anyone who never touches it, and the 18+ gate, dialogs, and Watch pages follow the same choice. See [the theme layer](#daynight-theme-layer) before editing any colour
- Dedicated details pages with metadata, tags, availability labels, a smart episode index whose cards open episode-specific delivery pages, related releases, individual file/quality delivery choices, and a polished all-files Telegram delivery dialog. When a publisher manually attaches an approved provider player, the existing card also gains a **Watch** button leading to an in-site embedded Watch page with episode/source choices and related titles from the same category. Episode-based releases intentionally keep quality/file choices inside the selected-episode page instead of showing a confusing all-release picker. On every file list, qualities are ordered as an ascending ladder (**280p → 480p → 720p → 1080p → 1440p → 4K**, unknown quality last) rather than in upload order, and each row shows the complete uploader wording under a shortened label instead of a cut-off name. An episode page also carries a compact **Watch** panel that lists every player the publisher attached to that episode (via `/cmd`), so an episode never looks unwatchable just because a player exists. Combined multi-episode uploads are listed in their own **Batch packs** block and never appear inside a single episode's file list, and a release whose files are complete seasons is grouped under one heading per season instead of twenty rows in one column. Every attached player is labelled with the service that hosts it (**Dailymotion server**, **Rumble server**, **Seek server**, or the approved host’s own name) instead of a nameless “Player 1”. The player box reserves room for the provider's own control row and squares off its bottom corners, so Dailymotion’s audio, subtitle, and full-screen buttons are neither squeezed over one another nor clipped by the frame, and a Dailymotion frame is additionally asked for **playback-only chrome** (`sharing-enable=0`, `queue-enable=0`, `reporter-enable=0`, `ui-logo=0`, `ui-start-screen-info=0` — its own documented parameters, and any value a publisher typed by hand is left alone) so the buttons that stay are the ones a viewer needs. Those controls belong to the provider inside its frame, so this site draws none of its own over or beside them — the one exception is full screen, which only the browser can grant, and a Watch page leads with the episode’s own name, adding a season number only when the release really is seasonal; a movie lists its languages there, so a film never shows an invented season and a series episode never shows nothing.
- Search supports multi-word matching, and every term has to agree: `ep 176`, `bleach episode 176`, and `long march s02` each reach the card that owns them, because episode numbers, the words `ep`/`episode`, and season labels are indexed with the release. A range such as a combined `E170-E180` upload makes every episode inside it findable, and a card published before numbers were indexed gains them with `/repair go`, which re-runs the search index along with the file and episode index
- **Every listing is a page, not a cap.** A browse category and a search result are paged thirty cards at a time, and the grid ends in a real pager — `Showing 31–60 of 412 releases` beside `Prev · 1 … 4 5 6 … 14 · Next`, where every number is a link (`/browse/anime?page=5`, and page one is the plain URL). So the back button, a middle click and a copied address all land where they look like they will, and moving to a page replaces the grid instead of stacking another thirty cards under it — that stack is what a deep shelf turned into on a phone, and why the count line now says which slice of the shelf you are looking at. A page that fails to load leaves the page that loaded on screen, names the page that failed, and offers `Try again`.
- **Genres and categories in the three-line menu.** The mobile drawer carries a `Genres & categories` row that opens the whole shelf list inside the menu — every category with the number of releases in it, and every genre tag the catalog uses, each one a link to a paged listing of exactly that. The row is laid out like the menu rows above it (a hairline, a muted icon, a chevron), and the panel it opens nests under it rather than appearing as a box glued to the foot of a list; the drawer paints itself from `--menu-*` tokens, so Day mode gets a light menu instead of a black slab. On a listing, the count line and its shelf buttons (`Genres`, `Categories`) are one row of equal-width pills — the category control only appears where the hero's own rail is hidden, and it expands the rail in place instead of floating a popover over the grid it is meant to change. A category nobody has filled yet is dimmed and dashed rather than daring the tap. **18+ is never in that list**: the endpoint that answers it skips the adult category inside the query, so an unconfirmed visitor cannot reach restricted cards by guessing a genre URL either. The same list has its own page at `/genres` for a wide screen, and a genre is a shelf cut across categories (`/browse?genre=Action` holds movies, anime, and donghua alike)
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
  - `/adultdb Title` (or the requested `/18db Title` alias) for a private 18+ draft
- Start a draft, send the title, upload files in the same private bot chat, then use `/done`. The adult command requires its own private storage channel, skips metadata-provider lookup, and never creates a public Telegram announcement
- Optional draft metadata commands: `/lang`, `/subtitles`, `/year`, `/genres`, `/description`, and `/poster` (also `/p` and `/imgdd`); the same metadata can be corrected on an existing private `SB-…` post ID
- Category-aware metadata fallback chain: AniList for Anime/Donghua, TMDB, then OMDb when configured
- Server-side poster download validation, then permanent ImgBB upload during publishing
- A generated category-colored PNG fallback poster **renders the release title** and is uploaded to ImgBB if no provider has suitable artwork
- Smart episode parser: cleans captions first, removes `@channel` / `t.me` attribution **and the promotional lead-in that carried it** (`❤️ Join ~ [ @twg]`, `🔥 For More Join @chan —`, a trailing `Subscribe to us`) so a caption never becomes `❤️ Join King of Prison`, recognizes `EP 01`, `EPI 01-06`, `Epi.01-06`, `Episode 1 To 5`, and `S01E01-E05`, then falls back to the filename. On a series card, a file whose only numbering is a plain number (`Show.12.mkv`, `Show 12 480p`) is read as **Episode 12** instead of being left out of the index, because that is how releases are usually named on Telegram. A feature film is never given an invented number, a `Complete`/`S01` pack is never reduced to one episode, and an extra (`Trailer`, `OST`, `Poster`, `Credits`) keeps its own name. If a file still cannot be numbered, the reply says so instead of losing it silently
- A Watch page heading is written for the viewer, not copied from the upload: the release name once, then the episode number (`Shrouding the Heavens · Episode 176`). A caption's repeated title, emoji, and `Quality: ✅` are decoration and are dropped, a real quality tag is kept as a chip (`Quality: 1080P`), and a caption that genuinely names the episode (`Reunion of Shadows`) becomes the heading instead of the number
- Season markers (`S02`, `Season 2`, `2x05`) are read per file. When one upload batch contains more than one season, `/done` publishes **one catalog post per season** (`Title Season 1`, `Title Season 2`, …) and each season's merge keys are season-scoped, so a later Episode-of-Season-2 upload appends to the Season 2 post instead of colliding with Season 1. Files without a season marker join the season block they were sent inside. Category and type are decided from the name plus the files themselves: a release whose title and files carry no season marker stays a single post and is **never** given a generated `Season 1` label, while one stray `S01` file inside an otherwise unmarked group cannot relabel the whole upload either
- Upload captions/file names resolve explicit audio and subtitle labels. For example, `Multi (Hindi + Malayalam)` is published as **Hindi** and **Malayalam**, never the unhelpful generic `Multi language` label. Dual/Multi or unlabeled media is inspected with MediaInfo only after the entire manual, batch, or auto release has collected; candidates are downloaded and parsed one at a time with byte, timeout, and file-count caps, so a failed/unavailable scan safely retains caption/filename fallback labels
- Post pages show a safe, public episode index; each episode card opens a dedicated page containing exactly the delivery files for that episode (all qualities, ordered low to high) plus the players attached to it, while combined episode ranges open their own pack page. Storage message IDs remain private
- Announcement-channel edits and deletions run on **one paced lane**, so a large `/batch` cannot trip Telegram's flood limit: a refused edit is retried after the wait Telegram asks for, a job that never gets through is reported to the publisher with its Post ID, and `/sync` (with `/sync go`) refreshes channel copy that no longer matches a card — which is how an old announcement still showing `@channel` gets corrected without re-uploading anything
- **`/repair`** re-runs today's indexing rules over every published card. A card is indexed once, when it is published, so a rule added later never reaches the cards that came before it: `/repair` previews what would change, `/repair go` applies it site-wide, and `/repair SB-…` fixes one card now. Only derived fields move (file records, episode blocks, counts, release label) — titles, Post IDs, slugs, posters, players, delivery links, and announcement messages are untouched, and nothing is re-uploaded. Running it twice is a no-op
- A file that names a **season** and no episode number is that season complete — how a whole-season upload arrives (`The.Simpsons.S01.1080p.DSNP.WEBRip`, `Show S03 Complete`, `Show.Season.5.Box.Set`). It is filed as a **complete season** instead of being reported as a file that lost its number: the card's delivery list gets one labelled block per season (`Season 1 · complete season`), each row keeps the uploader's own wording with an `S01` chip, the upload reply says `Season 1 complete season in one file (no episode number needed)`, and no `Ep 12` caption is ever asked for. Nothing is invented: a season must be readable in that file's own name or caption, so an extra (`Trailer 2`), a film, `S01E05`, or a season the card merely attributes to an unnamed file never becomes a pack
- Files are copied to the Telegram database channel at upload time and delivered with `copyMessage` only after a valid deep link starts the bot. Fresh copied/resend captions and saved file labels automatically remove Telegram `@channel`, `t.me`, and promotional attribution while preserving title, quality, language, season, and episode information
- `/batch Optional title` imports an inclusive existing `t.me/c/<internal-channel-id>/<message-id>` range from that private database channel as **one release**, including long runs such as 448 episode messages. It preserves original storage message IDs, retries Telegram rate limits, reports progress, infers title/category when no name is supplied, and enumerates every already-published, active-draft, non-media, inaccessible, or protected message ID instead of reporting a vague skip count. When no title is supplied and the collected files clearly belong to several different releases (for example `rrr`, `robots`, `ams`, and `Fullmetal Alchemist` seasons inside one range), the range is grouped by release title and published as **one post per release** — each with its own inferred title, category, and per-season split — rather than merging unrelated files under one guessed name, and every release still appends to an existing post of the same title. **The category is decided by evidence, not by habit.** `tv`, `ott`, or any other category may be written in front of the title (`/batch donghua | Peerless Martial Spirit`, `/batch ott | India Got Latent`), and that word wins outright. When no category was supplied and the caption or filenames say nothing either way, the release is asked of TMDB/AniList before the card is written, and *their* answer is used — `Peerless Martial Spirit S02E18.mkv` is filed under **Donghua** because the provider matches it as a Chinese series, not under Web series because a filename cannot tell the two apart. A provider that does not recognise the title, or a server with no TMDB key, changes nothing: the caption's own guess stands, because silence from an API must not misfile a release. The publish reply says which way it went (`Filed under Donghua, not Web series: the caption said nothing either way, so this is what tmdb calls “Peerless Martial Spirit”.`). **Each release's name is checked before a card is created:** a caption or filename is reduced to its title first, so packaging is never read as part of a name (`Minions DUAL -KyoGo mkv 🔊 #`, `Minions [1080p] [x265] - KyoGo.mkv`, and `Minions` are one release, not three cards with three announcements and three poster uploads); a caption that names nothing at all (`🔊 #`, `mkv`, `Document`) does not become a card either, and that file follows the release above it, the way a caption with only an episode label already did
- `/auto` presents persistent ON/OFF controls; when ON, direct database-channel media is collected by normalized release title for 90 seconds of quiet (15-minute maximum), then classified, provider-verified, poster-mirrored, and published as one combined post. Provider identity and cleaned aliases are retained so later noisy title variants append to the same post without a duplicate announcement
- Auto completion/failure reports are delivered to the authorized publisher's bot chat, including the private `SB-…` ID, while database-channel error replies are suppressed
- `/cmd SB-… ep 1 <player URL>` attaches one approved player to **Episode 1** immediately, `ep 2-7 <URL>` covers a whole range, and several links in the same message (space separated, one per line, a bullet list, or Telegram’s Markdown `[link](url)` form) are all saved at once. **Each line may name its own episode**, so a whole run is pasted in one message — `Ep 176 <link>` then `Ep 177 <link>` — and every link lands on the episode written in front of it (lines with no label continue the episode above them). The reply lists the episodes it covered, so a paste that collapsed onto one episode can never look like a success. A second player added to an episode that already has one **stays beside it** rather than replacing it, so Dailymotion and Rumble can both serve the same episode. `/cmd SB-…` then accepts a small JSON/CSV provider export for a full season, and `/cmd` can exact-match an exported `Title` or per-row `postId`; SeekStreaming’s `Embed Link`/`Embed Code` fields work directly. Dailymotion and Rumble **page** links are converted to the embeddable player path automatically, because the watch page itself refuses to be framed. A Watch page never sends a visitor to the provider to watch: when a player is framed there is no outbound link beside it at all, and the only source that gets one is a source with no embeddable player to frame (an OK.ru live broadcast), where a link is the way to watch rather than a way to leave. **Full screen** below the player is also real rather than decorative — it asks the browser to make the *iframe itself* the full-screen element with `navigationUI: 'hide'`, which is what the provider's own button does, so the browser bar goes with it and the frame is not merely grown inside the page layout. Browsers that will not let a frame take the screen (older iOS Safari) get no button instead of a broken one. `/players SB-…` lists what is attached with Remove buttons that name the card and the row they act on (`176`, `ep 170-180`, `missing`, `#12`, or a page number narrow a hundreds-of-episodes card instead of scrolling it), and `/cmd SB-… del 2`, `del 2, 4`, `del ep 5`, `del ep 2-7`, or `del all` removes them again. Episode players surface only beside the matching episode file’s Telegram action; they never become a misleading release-wide Watch button, and `ep` is omitted only for an intentional release-wide/main player. This creates/updates the existing in-site Watch page only—no new catalog post, video transfer, transcoding, or Telegram announcement occurs. Approved SeekStreaming/embedseek, Dailymotion, Rumble, **Vimeo**, **OK.ru**, Dood, StreamWish, Mixdrop, and StreamTape embeds are supported by default — Vimeo and OK.ru **page** links are converted to their player path the same way, and a Dood/StreamWish-style `/f/<id>` embed URL is used as given. If a **Rumble** embed shows a black frame, paste the code from Rumble's own Share dialog (`https://rumble.com/embedJS/u….v…/?url=…`) — the publisher token in it cannot be rebuilt from a page link, so that form is stored verbatim and plays. One-click download hosts (`mega.nz`, `gofile.io`, `abyss.to`, `krakenfiles.com`, `pixeldrain.com`, d.tube) are refused **as players** on purpose, because their page is a wait-and-continue form that also blocks framing; the reply says so instead of adding a frame that can never play, and those links belong in the post's file list. `STREAMING_ALLOWED_HOSTS` can add another trusted host.
- Publisher controls are locked behind `/login <passcode>` and can also be restricted by `TELEGRAM_ADMIN_IDS`
- Public `/request` messages are stored in MongoDB and mirrored into the private request/database channel; `/requests` opens a multi-select publisher workflow that marks selected requests **Completed** or **Rejected** and immediately notifies each requester
- `/category`, `/lang`, `/subtitles`, `/genres`, `/year`, `/release`, and `/status` accept a **list of Post IDs** before the value (`/category SB-0123ABCDEF, SB-1122334455 anime`), so one mislabelled batch is corrected in a single line. There is **no cap on the number of posts** in the list — as many IDs as fit in the message are applied, and the whole argument is read at Telegram's message length instead of a short prefix, so a 20-post correction arrives complete; every named post is updated, each post’s existing Telegram announcement is edited in place, unknown IDs are reported and skipped, and a restricted 18+ post in the list is left alone instead of failing the whole command. Titles, synopses, and artwork stay one-post-at-a-time because they are per-release identity
- Unlimited announcement channels can be managed with `/addchannel`; each new post gets a professional poster, metadata card, and website detail-page button
- Every post receives a private `SB-…` Post ID. `/posts 50` lists recent IDs and `/postid` filters them by Today/Yesterday/Week/Month; **`/search <text>`** matches titles, filenames, and IDs and answers with the Post ID of each card (split across messages when the list is long, never truncated). Anything that already points at a card also answers itself: **forward the announcement post to the bot**, or **paste the catalog page link** (`…/kdrama/our-sticky-love`) or the `t.me/c/…/123` message link, and the reply is that card's Post ID with the commands that use it, so an ID never has to be hunted for. **`/title` onto a title the catalog already holds offers the merge** on the spot (the files move into the card that existed first, the duplicate and its announcement are deleted, and *No* leaves both alone). and `/delete SB-…` can remove one or several unwanted catalog cards. Authorized publisher command scopes are registered on startup and when an allowed owner opens/logs into the bot, so `/posts`, `/postid`, and other publisher commands remain visible through Telegram menu caching
- `/merge <title (optional)> <target Post ID> <Post ID to absorb> [more IDs]` collapses cards that a provider split apart: the target keeps its ID, slug, poster, and delivery links, every file and player of the other cards moves onto it, its season blocks are rebuilt (Season 1 with its episodes, then Season 2 with its own Episode 01 — same-numbered episodes of different seasons never overwrite each other), and the absorbed cards plus **their announcement-channel messages** are deleted while the private storage messages stay untouched. A title in front is a safety check that stops the merge when that Post ID carries another name, mistyped IDs are reported instead of read as titles, 18+ cards are never mixed with normal ones, and the plan is applied only after **Confirm merge** or `/merge confirm`. `/merge drop SB-… season 2`, `ep 5`, or `season 2 ep 5-7` trims files back off one card and reports the players left behind

- `/lang SB-ID Hindi, English`, `/year SB-ID 2026`, `/title SB-ID …` (or one `/title`-style line per post in a single message to rename a whole list at once), `/genres SB-ID …`, `/description SB-ID …`, `/poster SB-ID https://…` (or `/p`, `/imgdd`), `/subtitles SB-ID …`, `/category SB-ID …`, `/release SB-ID …`, and `/status SB-ID …` edit an already-published catalog card without changing its stable slug/share delivery identity. A corrected **title or category re-derives the episode index from the files themselves**, so a card published before its caption made sense (or renamed onto one) stops listing `S01 [Epi 01-06]` deliveries as one flat release on the page and in the channel copy; `/lan` and `/lam` are compatible `/lang` aliases
- `/backup` creates a signed gzip application snapshot and sends it only to the configured private storage channel; `/recover` accepts one signed backup document in an authorized private publisher chat and restores it into the current database, including a new/empty MongoDB URI. A durable India-calendar-month scheduler sends one automatic backup each month
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

### Day/Night theme layer

`src/client/styles.css` holds the night theme and is the only place a colour is authored. The day theme is **generated** from it: `scripts/build-light-theme.mjs` walks every rule, maps each colour literal by role (ink darkens, surfaces lighten, brand fills and scrims over artwork stay, the video surround is never touched) and writes `src/client/styles-light.css` with the same selectors under `[data-theme='light']`. `npm run theme:build` regenerates it after changing any colour, and `npm run theme:check` — which `npm test` runs too — fails when the layer has drifted, so a new rule can only ship themed in both modes or in neither. The choice itself lives in `src/client/theme.js`: `data-theme` on `<html>`, `localStorage`, `color-scheme`, and the `theme-color` meta that paints the mobile browser bar, applied before first paint by an inline script in `index.html` so no bundle download is needed to get the right colours.

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
# Required before /adultdb, /18db, or /batch adult | Title. This must be a
# different private channel; adult files are never mixed with normal storage.
TELEGRAM_ADULT_STORAGE_CHANNEL_ID=-1009876543210
# Optional separate private channel for user requests; otherwise storage channel is used.
TELEGRAM_REQUEST_CHANNEL_ID=-1001234567890
# Optional allowlist. If set, only these IDs may successfully use /login.
TELEGRAM_ADMIN_IDS=123456789,987654321
# Required publisher passcode; set your desired value as a Koyeb secret (for example, AYU).
ADMIN_LOGIN_CODE=your_private_publisher_passcode
ADMIN_SESSION_HOURS=24
# Set this separately and keep it stable across admin-passcode rotations.
BACKUP_SIGNING_SECRET=a_long_random_backup_signing_secret
TELEGRAM_MODE=polling
```

`ADMIN_LOGIN_CODE` is required to unlock publishing. A logged-in publisher session expires automatically after the configured number of hours. `TELEGRAM_ADMIN_IDS` is an optional additional safety layer: when it is populated, only those numeric Telegram user IDs can log in even if somebody knows the passcode. When it is empty, the passcode itself controls access.

#### Private 18+ storage and access

Create a **second**, private Telegram database channel for 18+ files, add the same bot as an administrator, and configure its numeric ID as `TELEGRAM_ADULT_STORAGE_CHANNEL_ID`. It must not equal `TELEGRAM_STORAGE_CHANNEL_ID`; the bot rejects a shared/missing configuration before an 18+ draft, batch, publish, or delivery can use it. Start restricted uploads with `/adultdb Title` or `/18db Title`. Existing adult-channel ranges use `/batch adult | Title`; normal `/auto` remains restricted to the normal database channel. Adult drafts skip external metadata lookup, retain their per-file source channel, and never announce to configured public Telegram channels.

The website intentionally shows the 18+ navigation destination without its catalog data. Selecting it opens a confirmation dialog; **No** returns to the regular catalog, while **I am 18+** is a truthful declaration that the visitor is at least 18 (or their local age of majority) and legally permitted to access the category. It does not falsely claim to verify identity, monitor IP addresses, or share visitor data. The server independently requires its short-lived HTTP-only consent cookie for adult category/detail/episode/Watch APIs and first-party `/deliver/...` redirects, so an overlay or a guessed site API URL cannot expose restricted data before confirmation.

#### Bot-token rotation and replacement recovery

Delivery URLs are **not stored with a bot username** in MongoDB. Catalog buttons use stable first-party `/deliver/...` URLs, which redirect to the currently active Telegram bot at click time. When a token is rotated, deploy the new `TELEGRAM_BOT_TOKEN`; at launch, the service asks Telegram which `@username` owns that token and uses it for all catalog and per-file links automatically. This also handles a replacement bot with a different username — update the token, redeploy, and add the replacement bot as an administrator of the existing private storage channel so it can copy the saved messages.

Check `/api/health` after deployment: `deliveryBotUsername` must be the replacement bot. Existing catalog pages, their file buttons, and website-first announcement buttons will then resolve to it. A previously copied external `t.me/OldBot?...` URL cannot be rewritten after the old bot is banned; share the stable catalog page or its `/deliver/...` link rather than old direct links when recovering.

#### Storage-channel troubleshooting

Use the channel's **numeric** ID (normally `-100…`), not its invite link. The bot must be an administrator with **Post Messages** enabled. SoraBox first uses Telegram `copyMessage`; if Telegram refuses a copied/forwarded file, it automatically retries by sending the file ID in its original type. If Telegram says the source is protected, send the original file directly to your bot instead of forwarding it from a protected channel. `/batch` only accepts a private `t.me/c/...` link whose internal ID maps exactly to `TELEGRAM_STORAGE_CHANNEL_ID`; it temporarily forwards each requested message into the logged-in publisher’s private chat to inspect it, then deletes that preview. Its final report names every inaccessible/protected, non-media, already-published, and active-draft message ID and reason. If a previous broken auto run already created one-file cards, those IDs are deliberately reported as already linked; use `/posts 50`, remove the unwanted cards with `/delete`, then rerun `/batch` to build one clean post.

### MediaInfo audio/subtitle inspection

The production Docker image installs `mediainfo`. SoraBox does **not** download or inspect every upload while a publisher is still uploading. Instead, at the final `/done` stage (including after `/batch` and an auto-publish group finishes collecting), it queues only files whose labels say **Dual**, **Multi**, or do not contain a concrete audio language.

Each eligible candidate is handled **sequentially**: the stored Telegram file size is checked first, it is downloaded to a temporary file only when it is within the configured cap, MediaInfo reads Audio/Text tracks, then the temporary file is removed before the next file. The detected ISO tags are normalized to public labels such as Hindi, English, Japanese, and Chinese; audio and subtitle labels are stored separately and displayed separately on a release page. A source with no tagged tracks, a file above the cap, Telegram's cloud download limits, a timeout, or an unavailable binary never blocks publishing—the caption/filename result remains the safe fallback and the scan state is recorded privately on the file.

```dotenv
MEDIAINFO_ENABLED=true
MEDIAINFO_COMMAND=mediainfo
# Telegram's cloud Bot API normally downloads up to 20 MB. Raise only when your
# Bot API deployment supports it and your Koyeb memory/network budget permits it.
MEDIAINFO_MAX_DOWNLOAD_BYTES=20971520
MEDIAINFO_TIMEOUT_MS=45000
# A hard sequential bound that still accommodates long inclusive ranges.
MEDIAINFO_MAX_FILES=500
```

### Signed backup and recovery

Set a stable server-only backup signing secret before relying on recovery:

```dotenv
BACKUP_SIGNING_SECRET=a_long_random_secret_at_least_12_characters
BACKUP_MAX_BYTES=19922944
BACKUP_MAX_UNCOMPRESSED_BYTES=83886080
BACKUP_DOWNLOAD_TIMEOUT_MS=60000
BACKUP_MONTHLY_ENABLED=true
```

Run `/backup` from an unlocked publisher chat to export catalog records, upload sessions, requests, private bot/site analytics, announcement destinations, and automation/backup settings as one signed, gzip-compressed document in `TELEGRAM_STORAGE_CHANNEL_ID`. The archive contains **application data only**—not a MongoDB URI, Telegram token, ImgBB/TMDB key, passcode, or other environment secret. It does contain private catalog file references and analytics, so keep the storage channel and downloaded archive private.

SoraBox verifies the HMAC signature before it writes anything on `/recover`. In an unlocked **private** publisher chat, run `/recover`, then send the unmodified `.json.gz` document within 15 minutes. This replaces the backed-up application collections in the currently configured MongoDB database, so it works after pointing `MONGODB_URI`/`MONGODB_DB` at a new empty deployment. Keep `BACKUP_SIGNING_SECRET` unchanged across that migration; if it changes, old archives intentionally fail verification. Active login/request-selection/recovery prompts are intentionally not imported because they are short-lived authorization state; log in again if a process has been restarted.

The bot checks on startup and every six hours for a completed backup in the current **India calendar month**. A durable MongoDB claim permits one automatic archive per month even across restarts. A successful manual `/backup` also satisfies that month. Set `BACKUP_MONTHLY_ENABLED=false` only if an external backup policy replaces it.

### 4. Configure permanent ImgBB posters

Set your ImgBB server API key as **`IMGBB_API_KEY`**. It is used only by server-side publishing code. Do **not** commit it, put it in a `VITE_` variable, or paste it into client code.

```dotenv
IMGBB_API_KEY=your_imgbb_server_key
```

If you publish in bulk, add your other ImgBB keys as **`IMGBB_API_KEYS`** — up to 20 of them, in any mix of commas, spaces, and newlines, or as `IMGBB_API_KEY_2` … `IMGBB_API_KEY_20` if your host prefers one secret per line. A release of a hundred cards is a hundred uploads, which is more than one free ImgBB key is built to absorb; a pool of ten turns the same burst into one upload per key per pacing window. Ten is the recommendation, twenty the ceiling, and one is still a valid configuration: nothing about a single-key deployment changes.

```dotenv
IMGBB_API_KEYS=key1,key2,key3,key4,key5,key6,key7,key8,key9,key10
```

At `/done`, the server does this for every card it publishes (one card per detected season):

1. Uses the selected/manual/AniList/TMDB/OMDb poster if available.
2. Validates the source is a public HTTPS image and limits it to 8 MB.
3. Uploads a copy to ImgBB.
4. Saves only the hosted ImgBB URL and non-sensitive provider metadata in MongoDB.

If automatic matching finds no poster, SoraBox generates a branded category-colored fallback PNG **with the release title rendered on it** and uploads that to ImgBB instead. This keeps the poster path hosted externally, recognizable in the catalog, and avoids loading Koyeb storage.

**Replacing artwork later — `/poster` (also `/p` and `/imgdd`).** Both styles are supported at the same time:

- **Old style (direct link):** `/poster SB-0123ABCDEF https://host/poster.jpg`. The URL must be a public HTTPS image of at most 8 MB; it is downloaded, mirrored to ImgBB, and only then written to the card. A private host, a non-image response, or an ImgBB rejection leaves the existing poster untouched.
- **New style (search and pick):** `/poster SB-0123ABCDEF Perfect World` (a year is optional). SoraBox searches AniList, TMDB, and OMDb artwork, scores the results against the requested title, and answers with up to 10 inline **Poster** buttons. Tapping a button mirrors exactly that image and updates the card's poster/backdrop, then previews it back in the chat. An ambiguous or unmatched title is reported instead of guessing.
- **Draft artwork:** send `/poster https://…` or `/poster Title` before `/done`; the choice is stored on the draft and mirrored during publishing.
- A bare `/poster` (or `/poster help`) asks which style you want and keeps a small pending conversation (`poster_flows`, 15-minute TTL) so you can reply with only the Post ID, then only the link or title. **Cancel** and **Search again** are always offered, and an expired menu says so instead of changing anything.

**A rate-limited image host never loses a release.** A bulk `/done` over a hundred cards uploads a poster per card, and ImgBB answers `Rate limit reached` when that happens quickly. Publishing is now paced and forgiving rather than fatal:

- uploads are spaced by `IMGBB_UPLOAD_SPACING_MS` (1.6 s by default) **per key** instead of firing together — with a pool, that is a per-key gap, not a global one;
- **one key is one quota, so a pool is what a bulk publish needs.** `IMGBB_API_KEYS` takes up to 20 keys (comma, space, or newline separated — `IMGBB_API_KEY_2` … `IMGBB_API_KEY_20` work too for hosts that keep one secret per line, and `IMGBB_API_KEY` stays the first key). the pool is **sticky, not round-robin**: one key carries every upload until that key refuses, and only then does the next free key take over, each key paced on its own clock. Rotating per upload would re-handshake and re-warm a cold quota for every card, which on a 117-poster release is minutes of pure waiting;
- a key that answers `429` is cooled down for what it asked for (`Retry-After`, otherwise `IMGBB_KEY_COOLDOWN_MS` / its own refusal count) and is **skipped by the following cards** rather than retried, while the rest of the pool keeps hosting;
- a `429` is retried up to `IMGBB_RATE_LIMIT_ATTEMPTS` (3) times inside the same call — each retry on the next free key — waiting `Retry-After` when ImgBB sends one and `IMGBB_RATE_LIMIT_BACKOFF_MS` (20 s) when it does not;
- when **every** key is cooling, nothing is tried and nothing is lost: the publish is deferred to the retry queue below and the report says so with a number — `all 10 configured ImgBB keys are rate limited right now … the next one is free in about 4 min` — and the queue wakes on that countdown rather than on its own default interval;
- with four keys or more the per-key gap relaxes to `IMGBB_POOL_SPACING_MS` (900 ms) — a key that is not alone at the door does not need the courtesy gap — and a lone key will still sit out a short `Retry-After` inside one upload up to `IMGBB_KEY_PATIENCE_MS` (15 s) before deferring, so a single-key deployment behaves exactly as it always did;
- **identical artwork is hosted once**: uploads are keyed by the image's SHA-1, so a re-run of `/done` over the same releases reuses the existing ImgBB URL rather than adding a second copy for the same bytes;
- if the host is still refusing after that, the card is **published anyway** with the artwork it already has, and the mirror moves to a background retry queue — `POSTER_RETRY_INTERVAL_MS` (5 min) apart, doubling per attempt, `POSTER_RETRY_ROUNDS` (8) attempts before the publisher is told once. When a retry lands, the card and its channel post are updated **in place** — the photo itself is edited, not reposted — and the publisher hears about it as **one list per tick** naming the affected Post IDs, never one message per poster: no second post, no re-upload, nothing to resend;
- `/poster` behaves the same way: a busy host defers your chosen artwork to that queue instead of replying `Poster was not changed`, so a pick is never lost;
- a poster that fails for a real reason (too large, not an image, host rejected the file) is still reported as a failure — only a rate limit is treated as something to wait out.
- **`/cancel` stops a run in progress.** The publish loop re-reads the draft between cards, so cancelling (or a `/done` that was interrupted) halts at the next release instead of continuing through the remaining hundred; the report says where it stopped. If a card failed for some other reason, your draft is kept until every group in it is published, and the next `/done` merges into the same cards rather than making second ones.

Because that queue lives in memory, a deploy discards whatever is still waiting; those cards keep their source artwork, and `/poster SB-… <link>` re-hosts any of them on demand.

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
| `/anime`, `/cartoon`, `/donghua`, `/kdrama`, `/movie`, `/series` | Start a normal category draft; title may follow the command |
| `/adultdb Title` / `/18db Title` | Start an isolated 18+ draft; requires a distinct `TELEGRAM_ADULT_STORAGE_CHANNEL_ID` and never announces publicly |
| `/batch Optional title` | Import an inclusive first/last `t.me/c/...` range from the configured private storage channel; omit title to infer it, or use `category \| title` to override category (for example, `/batch adult \| Title` for the isolated adult store) |
| `/auto` | Show persistent ON/OFF controls for direct database-channel auto-publishing |
| `/title Title` | Replace a draft title and re-run provider lookup; `/title SB-… Corrected title` edits an existing card without changing its delivery identity. **A whole list at once:** paste one line per post in a single message — `/title SB-1 Gold`, `SB-2 Oculus`, … — and every title is applied and reported together |
| `/lang Hindi, English` | Set draft audio labels; `/lang SB-… Hindi, English` edits an existing card, and `/lang SB-…, SB-… Hindi, English` corrects every named card at once (`/lan` and `/lam` are compatible aliases) |
| `/subtitles English` | Set draft subtitle labels; `/subtitles SB-… English, Hindi` edits an existing card, or list several Post IDs to correct them all (`/subs` is an alias) |
| `/year 2026` | Set draft year; `/year SB-… 2026` corrects an existing card, or `SB-…, SB-…` for many |
| `/genres Action, Fantasy` | Set draft genres; prefix with one or more `SB-…` IDs to edit published cards |
| `/description …` | Set a draft synopsis; prefix with `SB-…` to edit a published card |
| `/poster`, `/p`, `/imgdd` | Set artwork. `/poster https://…` overrides draft artwork and `/poster SB-… https://…` mirrors a replacement poster to ImgBB before changing a published card (the original style). `/poster SB-… Exact Title` searches AniList/TMDB/OMDb artwork and returns up to 10 **Poster** buttons — tapping one mirrors that exact image and updates the card. A bare `/poster` asks which style you want and the conversation stays open for 15 minutes |
| `/category SB-… anime`, `/release SB-… Label`, `/status SB-… Updated` | Edit a published card’s category, release label, or status — one Post ID or a list of them; bare `/status` still shows the active draft |
| `/teststorage` | Send a harmless test message to verify the configured database channel |
| `/cancel` | Discard the active draft or a pending `/recover` prompt |
| `/done` | Mirror poster, create MongoDB record, announce to every configured channel, and return share + Post ID |
| `/posts 50` | List recent private `SB-…` post IDs for cleanup or management |
| `/postid` | Open Today, Yesterday, Week, and Month buttons to return uploaded post IDs with names for that period (IST) |
| `/search Our Sticky Love` | Return the Post ID of every card whose title, filename, or ID matches. Forwarding an announcement post, or pasting its catalog or `t.me/c/…` link, answers the same thing without a command |
| `/stats` | Show anonymous site-visitor/visit activity, private bot-user activity, catalog totals, and request status totals |
| `/cmd SB-0123ABCDEF ep 2 <player URL>` | Immediately attach one approved player to Episode 2 (or `ep 2-7` for a range, or several links in one message); no new post or announcement is created |
| `/cmd SB-0123ABCDEF del 3` / `del ep 2-7` / `del all` | Remove specific numbered players, every player of an episode range, or all players of that post |
| `/repair` — then `/repair go` | Re-index every published card with the parsing rules in the current build; `/repair SB-0123ABCDEF` does one card now. Nothing is re-uploaded and no title, player, or delivery link is touched; the channel copy of a card that changed is refreshed on the announcement lane |
| `/sync` — then `/sync go` | Show which announcement-channel posts no longer match their card (an old `@channel` handle, a stale file or episode count, replaced artwork) and refresh them one edit at a time; `/sync SB-0123ABCDEF` does one now, `/sync force` re-reads every card instead of answering from the sweep just done, and what Telegram refused stays listed instead of lost |
| `/sync db` — then `/sync db go` | The database channel on its own: read the caption of every copied file post and rewrite the ones still carrying a `@channel` prefix, a page at a time until the archive is done. `/sync db status` asks how far it got |
| `/players SB-0123ABCDEF` — or `176`, `ep 170-180`, `missing`, `#12`, `3` | List the card's players with their server name, provider URL, and a working Remove button: the whole list paged, one episode, a range of episodes, or only the episodes that still have no player |
| `/cmd SB-0123ABCDEF` | Arm a 15-minute private JSON/CSV import for that post; send a provider export with `Embed Link`/`Embed Code` or `embedUrl` columns, or paste player links straight into the chat |
| `/cmd` | Arm a JSON/CSV import that resolves each row by its `postId`/`adminId` or exact `Title`; use `/cmd cancel` to stop it |
| `/backup` | Create a signed compressed application-data snapshot and send it only to the private storage channel |
| `/recover` | Arm a 15-minute private-chat prompt for one signed backup document; after signature verification it restores backed-up application data into the configured database |
| `/delete SB-0123ABCDEF[, SB-FEDCBA3210]` | Remove one or several published catalog records and disable their deep links |
| `/addchannel -1001234567890` | Add a channel for automatic professional new-post announcements |
| `/channels` / `/removechannel ID` | View or remove announcement destinations |
| `/requests` | Open Select requests / Back controls, multi-select open requests, then mark selected requests Completed or Rejected; each requester is notified immediately |

When `PUBLIC_SITE_URL` is configured, publishing returns the stable catalog detail-page URL as the recommended share link, plus a private all-files Telegram button for the publisher. Without a website URL, it falls back to a direct link like:

```text
https://t.me/YourBotUsername?start=get-7kWJdR7oTg
```

The public site creates a stable all-files `/deliver/<code>` action and a separate `/deliver/<code>/file/<position>` action for every uploaded file. Each routes to the current bot's Telegram deep link only when clicked, so a bot replacement does not require a catalog migration. The detail page displays cleaned file labels, detected audio and subtitle languages, quality, size, and episode/range information so visitors can choose exactly one delivery option or request all files. A successful publish also returns a private `SB-…` Post ID for `/delete` or later metadata corrections. The user never sees the storage channel, raw Telegram file IDs, or that deletion ID.

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

### Attach a manual provider Watch page

After an **existing** release has been published, upload authorized media through your provider's own dashboard. For the SeekStreaming export shown in the dashboard, use either the `Embed Link` such as `https://soraboxs.embedseek.com/#58yvk` or the full `iframe` Embed Code. SoraBox safely extracts and validates its `src` value; it does not log in to the provider, automate a browser, or upload the video through Koyeb.

The provider’s **watch page** URL is accepted too: `https://www.dailymotion.com/video/x123` (or the short `https://dai.ly/x123`) is stored as `https://www.dailymotion.com/embed/video/x123`, and `https://rumble.com/v7exnu4-title.html` as `https://rumble.com/embed/v7exnu4/`, because those pages send framing headers that make a browser report “refused to connect”. The page you pasted is kept as the provider link, so a Watch page can still offer **Open on Dailymotion/Rumble** when a device cannot play the frame. Telegram’s Markdown form `[https://rumble.com/v….html](…)`, a copied `<iframe>` snippet, one link per line, and a bullet list are all read the same way.

For one player, copy the Post ID returned by publishing and send either form in your private publisher chat:

```text
/cmd SB-0123ABCDEF https://soraboxs.embedseek.com/#58yvk
```

```text
/cmd SB-0123ABCDEF <iframe src="https://soraboxs.embedseek.com/#58yvk" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>
```

For a provider export containing several episodes or sources, first target the existing post, then send the `.json` or `.csv` file as a **Telegram document** within 15 minutes:

```text
/cmd SB-0123ABCDEF
```

Recommended CSV form:

```csv
postId,episode,label,embedUrl,watchUrl
SB-0123ABCDEF,1,Episode 01,https://soraboxs.embedseek.com/#episode-1,https://seekstreaming.com/#/video/episode-1
SB-0123ABCDEF,2,Episode 02,https://www.dailymotion.com/embed/video/x123,
SB-0123ABCDEF,2,Episode 02 · Rumble,https://rumble.com/embed/v123,
```

Several links can be saved in one message, which is how a single episode gets two sources or a whole run gets one server each:

```text
/cmd SB-0123ABCDEF ep 2 https://www.dailymotion.com/video/x123 https://rumble.com/v7exnu4-title.html
/cmd SB-0123ABCDEF ep 2-24 https://soraboxs.embedseek.com/#season-one-pack
```

Links pasted by hand are **added**, never silently swapped: a Rumble link for an episode that already has a Dailymotion player leaves both attached, each keeping its own server name and appearing as its own choice under the player. A provider export behaves the other way round — re-importing the same provider row for the same episode replaces that player, so a corrected `.csv` fixes a broken link without duplicating it or disturbing sources from other providers.

To undo anything, `/players SB-0123ABCDEF` lists every attached player with its number, server name, episode, and URL, and offers **Remove** buttons for exactly those numbers:

```text
/players SB-0123ABCDEF
/cmd SB-0123ABCDEF del 3
/cmd SB-0123ABCDEF del 2, 4
/cmd SB-0123ABCDEF del ep 5
/cmd SB-0123ABCDEF del ep 2-7
/cmd SB-0123ABCDEF del all
```

Deletion touches only that post’s player list — no file, title, or announcement changes, and a post whose last player is removed simply stops offering a Watch page.

A card that runs to hundreds of episodes is **narrowed rather than scrolled**, and every row of the list carries its own `✕ Episode 176 · Dailymotion` button, so a single player can be taken off one episode without typing anything:

```text
/players SB-0123ABCDEF 176          one episode's players
/players SB-0123ABCDEF ep 170-180   a range of episodes
/players SB-0123ABCDEF missing      the episodes that have no player yet
/players SB-0123ABCDEF #12          jump to the page holding row twelve
/players SB-0123ABCDEF 3            page three of the whole list
/players SB-0123ABCDEF ep 176 2     page two of that episode's players
```

Any view accepts a page after it (`ep 176 2`, `missing 3`), and two numbers where the first is neither an episode of that card nor a real page is answered with a question rather than a guess.

The header of the full list states the coverage (`28 of 30 episodes have a player · page 1 of 4`) and names the oldest gap with the command that fills it. `missing` counts a player only when the link covers that episode, so a release-wide link never hides a hole; tapping a gap in that view opens the episode view that prints `/cmd SB-0123ABCDEF ep 13-14 <player URL>` ready to paste. Paging, filtering, and removal all re-render the same message in place (a redraw that would change nothing is swallowed instead of answered with a duplicate message), and **Remove all N** is offered only on the unfiltered list — a filtered view offers `✕ Remove all 2 for Episodes 01–02`, which cannot reach the rest of the card.

When a target Post ID is supplied, provider exports may omit `postId`; their `Title`, `Embed Link`, `Embed Code`, `VideoID`, `Download Link`, and `Size` fields can remain exactly as exported. With bare `/cmd`, each row must contain `postId`/`adminId`, or a `Title` that exactly matches one catalog post (ambiguous titles are rejected rather than choosing the wrong category). Re-importing the same provider + episode replaces that player entry, while another approved provider for the same episode remains available as an alternative on the Watch page. An export’s `Episode` column accepts a bare number or range (`4`, `2-7`) as well as `S01E03`/`1x03` markers, so a season-long export addresses one player per episode instead of collapsing onto the first one.

`/cmd` updates only `stream` metadata on the existing record. It preserves the `SB-…` ID, slug, delivery links, files, category, and announcement history, and **never sends an announcement**. The public release details page shows a **Watch** button above delivery actions. Its `/watch` page embeds the approved provider player, offers available episode/source choices beneath it, and shows related releases in the same category.

By default only HTTPS hosts under `seekstreaming.com`, `embedseek.com`, `dailymotion.com`, `dai.ly`, `rumble.com`, `vimeo.com`, `ok.ru`, `dood.pm`, `doo.sh`, `streamwish.to`, `mixdrop.to`, and `streamtape.com` are accepted and included in the site's iframe Content Security Policy. Every approved host is added to the policy automatically, so a new provider needs no CSP edit. To intentionally approve another provider, add only its trusted hostname to Koyeb (for example `STREAMING_ALLOWED_HOSTS=player.example.com`) and redeploy. The document is capped at 512 KiB with a 15-second download timeout by default; `STREAMING_MANIFEST_MAX_BYTES` and `STREAMING_MANIFEST_DOWNLOAD_TIMEOUT_MS` may be lowered or adjusted within their safe limits. No video byte passes through the SoraBox/Koyeb process.

### Correct many published posts at once

Metadata edits take one Post ID or as many as needed, separated by commas, spaces, or semicolons:

```text
/category SB-0123ABCDEF, SB-1122334455, SB-9876543210 anime
/lang SB-0123ABCDEF, SB-1122334455 Hindi, English
/subtitles SB-0123ABCDEF, SB-1122334455 English
/status SB-0123ABCDEF, SB-1122334455 Ongoing
```

Only the Post IDs at the very front of the message are read as targets, so a value that contains commas (`Hindi, English`) or a file name that merely starts with `SB-` is never mistaken for another ID. The reply names each post it changed, lists any ID it could not find, and reports how many announcement messages were edited. A category change into or out of 18+ is refused for that one post (its storage channel and age gate must stay separate) while the rest of the list is still corrected.

`/description` and `/poster` intentionally do **not** accept a list: a synopsis and artwork identify one release, so copying them across posts would be a mistake rather than a shortcut. `/delete POST_ID[, POST_ID]` already accepts a list.

**Comma-separated title batches — `/titlebatch`.** Send the command and the list in one message:

```text
/titlebatch SB-0123ABCDEF RRR , SB-1122334455 PK , SB-AABBCCDDEE Jine Nahi Duga
```

Use a space on **both** sides of each separator (` , `), or put each ID/title on its own line. A comma inside a title (`Hello, World`) stays part of that title. Missing separators that leave another Post ID inside a title are reported rather than saved as one long name. Invalid entries are skipped and reported; repeated IDs use the last title. A command by itself shows usage. Existing `/title` commands still work.

When Telegram cannot fetch a poster URL during an announcement update, the bot downloads the original image using the poster service's safety checks and uploads its bytes to the same message. It does not create a duplicate post or substitute artwork. If both paths fail, the update stays pending and reports the error; use `/sync go` after the host is available again.

**Renaming a page of cards at once — `/title` with one line per post.** After a bulk `/done`, correcting titles used to mean one message per card. A multi-line message is now read as one request:

```text
/title SB-85F36EE4CC Vampires Of The Velvet Lounge
/title SB-E47CB05E36 Gold
SB-B65405F26C Oculus
/title SB-593FCD898E Stand Your Ground
```

- each line is an independent edit, so a hundred lines are applied by one message — and there is no cap on how many a paste may name;
- the `/title` prefix is optional on every line after the first, since Telegram only treats the first one as a command, and IDs may be lowercase;
- a line that cannot be a rename is **named in the reply** rather than guessed at: no Post ID, no title, or several post IDs sharing one title (a title belongs to exactly one card). Everything else still goes through;
- if one card is listed twice, the last line wins and the reply says so;
- **a title you typed is stored as you typed it.** Only the furniture a pasted filename carries is removed — a release extension, a bracketed group tag, underscores, dot-separated words, and a trailing quality or codec label — and the reply counts how many titles were tidied so you can send any of them back exactly as written. A year, a season number, or `Dr. No` is never touched;
- each corrected card's announcement is edited through the shared lane, one at a time, so 36 renames never turn into 36 simultaneous channel edits — and the reply arrives whether or not the channels have caught up.
- **a corrected title also re-checks the artwork.** A card whose poster was only a generated placeholder — or was matched under the name the file came in with — is searched again on the same lane, and the poster it finds replaces the card, its backdrop, and its channel copy in one go. A poster a publisher chose by hand is never overwritten, and a card whose title still matches the artwork it was found under costs no search at all. If ImgBB will not take another upload, the card goes to the poster queue rather than being left blank.

### The delete that follows through

`/delete` takes the announcement with it. A card that no longer exists must not leave a live offer for it in a channel, so `/delete` now also deletes every posted copy of each card it removes — in all channels, one message at a time on the same paced lane that edits use. Thirty cards are therefore never thirty simultaneous channel calls: a `Too Many Requests` is waited out and retried, `/sync` lists any copy still standing, and a card that was never announced is simply reported as having nothing to remove. The reply says what it did, e.g. `Deleted 4 catalog posts: SB-… , SB-…` followed by `6 channel announcement copies were deleted with them, one message at a time on the lane.` The original files stay in the private database channel, as before.

### Announcement edits, flood limits, and `/sync`

A sweep says what it looked at, not only what it changed: `/sync` opens with `▸ 412 announced cards checked in 84 ms — 3 need a channel refresh (5 posted messages), 409 already match and cost no call at all`, and `/sync go` right after it is answered from that same sweep (up to `SYNC_PREVIEW_TTL_MS`, default two minutes) instead of reading the whole announced archive twice — only the few cards about to be edited are re-read, and a card that caught up in between is dropped from the queue and said so. `/sync force` always checks everything again. A refused copy is remembered per message with the caption it failed on, so repeating `/sync go` costs nothing until the card actually changes.

A channel copy this bot cannot rewrite is said as a reason, not as a count: `⚠ SB-702C01A205 · Some Title: 1 channel post still refused after 3 rounds. Telegram said: Forbidden: bot is not a member of the channel.`, or the one-round version that names the fix instead of repeating itself. `/sync` lists the same reasons per card, and `/sync retry` forgets which copies were written off as uneditable so they are attempted again.

Every change to a published card is mirrored onto the announcement message the bot posted in the channel, and Telegram refuses a burst of edits or deletions in the same chat. The old behaviour was that a 40-ID `/batch` fired 40 simultaneous edits, some failed with *Too Many Requests*, and the only trace was a line in the log.

So all channel work now runs on **one lane** inside the process:

- at most one call in flight, with a gap between them (`ANNOUNCEMENT_SYNC_SPACING_MS`, default 1.1s — the limit is measured in seconds, so a gap is the fix rather than more retries);
- a `Too Many Requests` reply is honoured inside the call: it waits exactly as long as Telegram asked and tries that edit again, up to three times;
- a job still refused after its rounds goes to the back of the lane for another round, and if it never gets through the **publisher chat is told which Post IDs are left**, because a wait that outlives the command's own reply must not become silence;
- a refresh **re-reads the card when it runs**. A queued edit carries the content it was asked about, and on a 48-card `/title` the lane reaches it a minute later - long enough for a poster re-match to have landed in between, so an edit built from that snapshot used to put the previous artwork back in the channel while the reply claimed it had been updated. The reply is now written from the real result (“its channel copy was updated with it”, “already showing that artwork”, or what stopped it);
- an announcement that went out **without** artwork - posted as a plain text copy because the card had no poster at publish time, which is what a rate-limited ImgBB used to cause - is upgraded as soon as one exists: the message is replaced with the photo, the reference flips to a photo one, and `/sync` counts it as “given their artwork for the first time”. If Telegram refuses the photo, the caption is still corrected and the refusal is remembered on that message instead of being paid for on every later edit;
- a refusal that cannot change for this bot is **classified instead of retried**: a rights error (`Forbidden`, `bot is not a member`, `not enough rights`) stops after one attempt and prints the fix (add the bot to the channel with *Manage messages*, then `/sync go`), and a copy that another account posted is dropped from the trail and remembered by message, so no later edit re-refuses it. Either way the `⚠` line and `/sync` carry Telegram's own words — "1 channel post still refused after 3 rounds" alone tells a publisher nothing to act on;
- `/sync retry` forgets that remembered list and the refusals stored on the cards, so the copies are attempted again once the bot's rights are fixed;
- `Bad Request: message is not modified` counts as success, and a post the publisher deleted by hand is forgotten — its reference is pruned rather than retried forever;
- every reference remembers the caption and artwork it was last sent with, so a repeat edit costs **no API call at all**. That is also what makes `/sync` cheap: it compares each card with what its channel post was last given, which finds the announcements published before the channel-tag cleaner existed and refreshes them once.

```text
/sync        — preview: which posts differ, how many are queued, what is still refused
/sync go     — refresh every one of them, one edit at a time
/sync SB-…   — refresh that card's announcement now and report the result
/sync db     — preview the database channel's own captions; /sync db go rewrites them all
/sync db SB-… — that card's file posts only
/sync db status — how far a running sweep has got
/sync db retry — forget refused and already-read messages, so they are looked at again
```

Nothing on the lane is awaited by a command handler. A bulk run is longer than a Telegram request timeout, and a handler that sits on it produces `Something went wrong while handling that request` on work that did go through; the queue therefore answers first and reports when it settles (`settleQueuedJob` bounds the one exception — a single-card edit — at 10 seconds).

### The database channel's captions (`/sync db`)

A file copied into the database channel keeps the caption it arrived with, and a publisher's channel usually opens every one of them with its own `@handle`. The website was never the problem: the catalog stores the *sanitized* label, so file rows and delivery names already read cleanly — but the message sitting in the channel still shows the prefix.

`/sync db` closes that gap the only way that can reach every post: it reads the captions from Telegram itself, on the same lane and with the same rule as an announcement edit.

The same scrub runs on the way **in** (`stripTelegramAttribution`), and it takes the whole advertisement off rather than only the handle: a bracket emptied by the removal, and the lead-in that pointed at it, go with it — at the start of a caption, at its end, and as a leftover `[ ]`. It only ever fires where the junk is *marked* as junk (a separator such as `~`, `—`, `|`, or an emptied bracket, or nothing after it), so a release genuinely named `Join the Circus` or `Follow the Money` keeps its name, and a caption that turns out to be nothing but advertising names no release at all, which is what the batch grouping uses to let that file follow the release above it. `/title` tidies a pasted line through the same path, so a typed title and an inferred one cannot disagree about what a release is called.

- every database message the catalog knows about is a candidate. The work list is built from `files.storageMessageId` alone, so a record that stored only a filename, a caption someone edited by hand afterwards, and a file posted before channels were tracked are all still found;
- each one is read through the same one-time preview `/batch` uses — forwarded into the publisher's chat, inspected, deleted again — and then edited to exactly the cleaned form of what Telegram reported. Nothing is composed from the catalog, so a caption that is already clean costs no edit and a file post that never had one is left without one instead of being handed a title;
- a file post saved before the catalog tracked which channel it went to is addressed through `TELEGRAM_STORAGE_CHANNEL_ID` (and the 18+ channel for adult cards), exactly the way `/batch` reaches it. Without that, an old database looked empty to the sweep — which is what `/sync db` reported while `/batch` kept cleaning the same messages;
- the reply names what it could not reach, so "nothing to clean" and "I could not look" are different answers: messages this bot cannot read at all (a protected channel refuses the preview), posts with no caption, files naming no channel, and where a page stopped;
- **a bot can only edit its own messages.** A post written by a human account or another bot is reported as uneditable and then remembered as such, so the next sweep spends no call on it — edit those in the channel yourself, or upload through this bot so the copy is clean from the start;
- one read and, if needed, one edit per `ANNOUNCEMENT_SYNC_SPACING_MS`, a `429` waited out and retried, and a caption that never gets through reported to the publisher chat rather than dropped;
- only a refusal that can never change is remembered. "That is not your message" is cached so the next sweep spends no call on it, while a flood wait or a missing admin right stays a real leftover that is retried and reported. **`/sync db retry`** forgets both caches — the refusals and the already-read-and-clean list — for after the bot's rights change or a file is re-uploaded through it;
- **one command walks the whole archive.** It pages instead of stopping: `STORAGE_CAPTION_SWEEP_CARDS` (25) cards and up to `STORAGE_CAPTION_SWEEP_LIMIT` (80) messages per read, then the next window, newest card first, until the catalog runs out or `STORAGE_CAPTION_SWEEP_TOTAL` (1500) messages have been read — and when it stops early for that reason it says so instead of looking finished. A card holding more files than a page allows (a season pack) is re-listed with a wider ceiling rather than having its files silently skipped;
- a channel that will not let its posts be forwarded is stopped at after the first page, with the reason said out loud — there is no point spending the archive on captions it cannot read;
- **the command never waits for the sweep.** Nothing on the lane is awaited from a handler any more: a whole-archive run outlives Telegram's own request timeout, which used to turn a command that had actually worked into `Something went wrong while handling that request`. The sweep answers in its own message when it settles, `/sync db status` reports progress while it runs, and a second `/sync db go` while one is running is refused rather than duplicated. A single-card edit may still wait — at most 10 seconds, after which the reply says it is queued and the lane reports later.

`/repair` does not touch this: it re-indexes cards. `/sync` refreshes announcement channels. `/sync db` is for the database channel alone.

### Long reports and the time a command is given

Telegram answers `Bad Request: message is too long` above 4096 characters, and Telegraf gives every update handler a fixed budget — 90 seconds by default — before it stops waiting on it. Both limits used to bite together on a 300-file `/batch`: the import finished, its report was refused, and the publisher was told *"Something went wrong while handling that request"* about work that had gone through.

- **every text reply is paginated instead of truncated** (`splitTelegramText`, `TELEGRAM_REPLY_CHUNK_LIMIT`, 3800 by default). A 261-line skip report or a whole page of caption targets arrives as `(1/n)`, `(2/n)` … messages with every line intact, and the inline keyboard stays on the first message so the buttons still point at something. An `editMessageText` has one message to work with, so it is clamped and the remainder is sent underneath it rather than dropped;
- **a large job is given room to finish** (`TELEGRAM_HANDLER_TIMEOUT_MS`, 20 minutes by default), and running out of that room is no longer reported as a failure — it means the work is still going, so the bot says so instead of asking for the command to be repeated;
- the sweep's preview names a whole page (25 cards by default) rather than the first three lines, because listing them is now safe.

`/batch` and the auto-publisher do their share as they go, and never inline: when an inspected file post still carries a prefix, the import hands the same edit to this lane and keeps importing, so a channel that is rate limiting delays a caption and never the release. Nothing is created for the fix — the message is only edited — and the import's reply says how many it handed over, with `/sync db` as the way to read back what is left.

Combined episode ranges are indexed as their own block: `Our.Sticky.Love.S01.[Epi.01-06].480p.mkv` (and `Epi 01-06`, `Ep.01-06`, `S01E01-E06`) contributes *Episodes 01–06* to the episode ladder, is not mistaken for a whole-season pack, and shows in the delivery sheet as its own range instead of the flat movie-style list a missing number used to produce. `/batch`, `/lang`, `/category`, `/poster`, `/merge`, and `/repair go` all queue through the same lane, so a bulk command answers its own reply instead of spending a minute editing a channel; the deletion of absorbed posts' announcements does the same, which is why a merge can no longer be spoiled by a channel that will not answer.

### Merge split cards into one post

Providers sometimes export one show as several cards — a card per season, or a season and its movie. `/merge` puts them back together. The **first** Post ID is the card that survives; every ID after it is absorbed into it:

```text
/merge Bleach SB-0123ABCDEF SB-1111222233 SB-4444555566
/merge SB-0123ABCDEF SB-1111222233
```

The target keeps its own Post ID, slug, poster, and delivery links. Every file and player of the absorbed cards moves onto it, its episode index is rebuilt into season blocks (Season 1 with its episodes, then Season 2 with its own Episode 01 — two seasons never overwrite each other's numbers), and the absorbed cards are deleted from the website **and** from the announcement channels. The private storage messages are never touched, so nothing has to be re-uploaded.

The title in front of the target ID is a safety check, not a search: it only has to agree with the card that ID points at (a shorter form of the same name is fine), and a clearly different name stops the merge instead of moving files onto the wrong card. A file with neither an episode number nor a season is named in the result, because a merge that appeared to lose episodes is otherwise impossible to tell apart from one that worked; a file that names only a season is reported as what it is (`Filed as 3 complete seasons (S1, S2, S3) — each of those files is a whole season, so it gets its own season block on the card instead of an episode number`), and a card built entirely from such files is described as indexing seasons rather than episodes. A mistyped ID (`Sb -29292`, `SB-112233445`) is reported as not being a Post ID rather than silently ignored.

Nothing changes until the plan is confirmed — the preview names each card, its file and episode counts, how many announcement messages will be deleted, and any card that was skipped. Confirm with the **Confirm merge** button or `/merge confirm`, and drop it with `/merge cancel` or `/cancel`. A card on the other side of the 18+ boundary is always refused, because storage channel and age gate follow the target.

To take files back off one card — a whole season, or an episode that landed in the wrong block — a trim is applied immediately and only touches that card:

```text
/merge drop SB-0123ABCDEF season 2
/merge drop SB-0123ABCDEF ep 5
/merge drop SB-0123ABCDEF season 2 ep 5-7
```

The reply reports how many files and episodes are left, warns when the card became empty, and names the players still attached to the removed episodes (`/cmd SB-0123ABCDEF del ep 5`). Because a drop can make a plan stale, it clears any pending merge. `/merge help` lists every form.

On the website, a card that spans seasons gets one heading per block, and an episode page keeps its season in the link (`/donghua/bleach/episode/1?s=2`) so Season 2's Episode 01 opens its own files rather than Season 1's. Cards with a single season are untouched, and the episode card design never changed: only the block heading and the season name inside the label were added.

Bare `/players` opens a short list of recent post IDs to choose from, and `/players SB-…` lists that card's players with **Remove** buttons — `176`, `ep 170-180`, `missing`, `#12`, or a page number narrow the same list when a card carries hundreds of episodes.

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

Every announcement the bot posts is remembered on the catalog record, so a later correction never leaves a stale card in the channel. `/delete` reads those same references and removes the posted copies along with the card, on the same lane and with the same retry-on-limit behaviour (see [the delete that follows through](#the-delete-that-follows-through)). Editing a published post with `/title`, `/lang`, `/sublang`, `/genres`, `/description`, `/category`, `/release`, or `/status`, replaced its artwork with `/poster` (either style, including the search-and-pick buttons, which list one artwork per row with its year, kind, and provider so a truncated label cannot hide which release it belongs to), or appending more files through a later `/batch`, `/done`, or auto-publish run **edits the already-posted announcement in place** with the same caption, poster, and **View on Website** button. The publisher reply repeats what changed, for example `Telegram announcements: 2 announcements updated.`; a post that was never announced simply says nothing else needed updating, and 18+ releases are never announced at all. Editing requires the bot to still be an administrator of that channel — if Telegram refuses, the catalog change is kept and the reply reports which announcements could not be edited. Announcements sent before this existed carry no stored reference and cannot be rewritten retroactively.

---

## Deploy to Koyeb (free tier friendly)

This repo includes a multi-stage `Dockerfile`. It builds the client once, then runs only the lean Node process on port `8000`.

1. Push this repository to GitHub.
2. In Koyeb, create a **Web Service** from that repository.
3. Choose **Dockerfile** as the builder and select `Dockerfile` at the repository root.
4. Expose **port `8000`** with the HTTP protocol and route `/` to it.
5. Set health check path to **`/api/health`**, with a generous grace period (about `30s`) and at least 5 attempts before a restart, so a container that is still waiting for its database is not killed mid-wait.
6. Use **one replica only**. Telegram long polling must have exactly one active bot consumer.
7. Add the environment variables below and deploy.

### When the domain answers `404: No active service`

That page is Koyeb's edge, not this app: it means the domain resolved fine but **no instance of the service is running**. Nothing to fix in a browser — open the service's **Deployments** tab and read the log of the most recent attempt, which is where the reason is printed:

- `Startup failed: MongoDB could not be reached after 5 attempts…` — the cluster was unreachable while the container was starting. The app sleeps between attempts (about 75 seconds in total, worst case) precisely so a **paused free-tier Atlas cluster waking up** cannot take the website down; if it still gives up, resume the cluster, then press **Redeploy**. Also confirm this service's egress address is on the cluster's Network Access allowlist, which is what a rotated or newly scaled cluster usually breaks.
- `Startup failed:` naming a missing variable — an environment value was lost on the new revision; re-add it and redeploy.
- An exit code without `Startup failed`, or a container that dies shortly after `SoraBox listening on 0.0.0.0:8000` — the instance was killed (memory, or a second replica fighting over Telegram long polling, which makes both bots restart). Keep **one replica**.
- No attempt at all, or the latest deployment left in `STOPPED`/`PENDING` — press **Redeploy** (or **Revert** to the previous revision if the newest code is at fault).

Every code push needs a deploy of its own: the site only changes when a revision that contains the commit is running, so a fix that is pushed but never deployed shows up as the old behaviour, not as an error.

| Variable | Koyeb type | Required | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | Plaintext | Yes | `production` |
| `PORT` | Plaintext | Yes | `8000` |
| `PUBLIC_SITE_URL` | Plaintext | Yes | Your canonical Koyeb site URL; announcement buttons open the post page here |
| `MONGODB_URI` | Secret | Yes | Mongo connection string |
| `MONGODB_DB` | Plaintext | No | Defaults to `sorabox` |
| `IMGBB_API_KEY` | Secret | Yes | Never expose it to the browser |
| `IMGBB_API_KEYS` | Secret | No | Up to 20 ImgBB keys to rotate uploads across (`IMGBB_API_KEY_2` … `_20` also work). Only needed when a bulk publish trips one key's quota |
| `IMGBB_POOL_SPACING_MS` | Plaintext | No | Per-key gap used once the pool has at least four keys; default `900` |
| `IMGBB_KEY_PATIENCE_MS` | Plaintext | No | How long a single-key deployment will sit out a short `Retry-After` inside one upload before deferring it to the poster queue; default `15000` |
| `SYNC_PREVIEW_TTL_MS` | Plaintext | No | How long a `/sync` sweep may be reused by `/sync go` instead of reading every announced card again; default `120000` (the refresh itself never waits longer than 60 s for it) |
| `IMGBB_KEY_COOLDOWN_MS` | Plaintext | No | How long a refusing key is rested while the rest of the pool keeps working; default `60000` |
| `IMGBB_UPLOAD_SPACING_MS` | Plaintext | No | Minimum gap between two ImgBB uploads; default `1600`. Raise it if a bulk publish still trips the host |
| `IMGBB_RATE_LIMIT_ATTEMPTS` | Plaintext | No | Upload attempts inside one publish before the poster moves to the retry queue; default `3`, up to `8` |
| `IMGBB_RATE_LIMIT_BACKOFF_MS` | Plaintext | No | Wait when ImgBB sends no `Retry-After`; default `20000` |
| `POSTER_RETRY_INTERVAL_MS` | Plaintext | No | Gap between background re-host attempts, growing per round; default `300000` (5 min) |
| `POSTER_RETRY_ROUNDS` | Plaintext | No | Attempts before the queue gives up and says so once; default `8` |
| `TELEGRAM_BOT_TOKEN` | Secret | Yes | BotFather token |
| `TELEGRAM_BOT_USERNAME` | Plaintext | Yes | No leading `@` |
| `TELEGRAM_STORAGE_CHANNEL_ID` | Secret or plaintext | Yes | Normal private channel numeric ID |
| `TELEGRAM_ADULT_STORAGE_CHANNEL_ID` | Secret or plaintext | Required for 18+ publishing | A different private channel numeric ID for `/adultdb`, `/18db`, and `/batch adult \| …`; no public announcements are sent for these posts |
| `TELEGRAM_HANDLER_TIMEOUT_MS` | Plaintext | No | How long an update handler may run before Telegraf stops waiting on it; default `1200000` (20 min). A large `/batch` needs the room |
| `TELEGRAM_REPLY_CHUNK_LIMIT` | Plaintext | No | Characters per outgoing message before a long reply is split; default `3800`, never above Telegram's 4096 |
| `TELEGRAM_REQUEST_CHANNEL_ID` | Secret or plaintext | No | Separate private request channel; defaults to storage channel |
| `ADMIN_LOGIN_CODE` | Secret | Yes | Publisher passcode; use your chosen value, not a client variable |
| `ADMIN_SESSION_HOURS` | Plaintext | No | Defaults to `24` |
| `TELEGRAM_ADMIN_IDS` | Secret or plaintext | No | Optional CSV numeric login allowlist |
| `BACKUP_SIGNING_SECRET` | Secret | Strongly recommended | Stable 12+ character HMAC secret for `/backup` and `/recover`; set separately from the login code |
| `BACKUP_MONTHLY_ENABLED` | Plaintext | No | Defaults to `true`; sends one signed private backup per India calendar month |
| `BACKUP_MAX_BYTES` | Plaintext | No | Default `19922944` (19 MiB); safe Telegram archive/recovery size cap |
| `MEDIAINFO_ENABLED` | Plaintext | No | Defaults to `true`; Docker installs the `mediainfo` runtime binary |
| `MEDIAINFO_MAX_DOWNLOAD_BYTES` | Plaintext | No | Default `20971520` (20 MiB) per ambiguous file, handled sequentially |
| `MEDIAINFO_TIMEOUT_MS` / `MEDIAINFO_MAX_FILES` | Plaintext | No | Defaults to `45000` ms / `500`; bounded final-stage MediaInfo scan |
| `TELEGRAM_MODE` | Plaintext | Yes | `polling` |
| `TMDB_API_KEY` or `TMDB_READ_ACCESS_TOKEN` | Secret | Recommended | Enables broader automatic metadata/posters |
| `OMDB_API_KEY` | Secret | Optional | Movie/series metadata fallback |

Koyeb's default route/port conventions also recognize port 8000, but setting it explicitly makes the service configuration clear. Keep the bot token, publisher passcode, **backup signing secret**, ImgBB key, TMDB/OMDb credentials, and MongoDB URI in Koyeb's secret store rather than in Git.

### Why it fits a small Koyeb instance

- React assets are built during the Docker build, then served as static files with compression.
- The server does not store poster files or media files on its disk; an eligible MediaInfo input exists only as one bounded temporary file during final publishing and is removed before the next file.
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
| `GET /api/categories` | Category labels with the number of releases in each, counted in the store (18+ reports `0` until the age cookie is set) |
| `GET /api/content` | One page of catalog records: `{ items, total, page, limit, pages, hasMore }`. `limit` defaults to 60 and is capped at 100; `total` is the whole shelf, never the size of the page |
| `GET /api/content?category=anime` | Filter by category (`category=adult` answers `403` until the age cookie is set) |
| `GET /api/content?genre=Action` | Filter by genre across every category, on the same paging envelope. Case and spacing are ignored, and 18+ is excluded inside the query |
| `GET /api/content?page=3&limit=30` | Any listing's third page; the site asks for thirty cards a page, paging is done with `page` (never `offset`), and a `page` past the end answers with the last page that holds cards rather than an empty grid |
| `GET /api/content?q=title` | Search titles, episode numbers, genres, or languages — every term in `q` has to match the same card |
| `GET /api/genres` | Every genre tag with its count, most-used first, 18+ never among them |
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
