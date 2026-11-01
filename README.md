# Media Renamer

Rename movie and TV episode files from public metadata and optionally move them into a library folder. It has a web app and a pipeline-friendly CLI, which share the same core in `lib/`. A downloader can also trigger an automatic import (with an optional Dolby Digital Plus audio fix) through an HTTP hook. It runs locally or in Docker, for example on an openmediavault NAS.

- **TV episodes** are matched on [TVmaze](https://www.tvmaze.com/api) (no key needed).
- **Movies** are matched on [TMDB](https://developer.themoviedb.org/) with an API key from the server configuration. Without a key, movies keep the name and year parsed from the file name and are marked as warnings.
- Every rename is previewed first and validated to stay inside the allowed folders. A batch is applied all-or-nothing and recorded in `<source>/.media-renamer-undo.json` so it can be undone.

Requires Node.js 26 or newer. The server has no runtime npm dependencies: it is written in TypeScript, which Node 26 runs directly. The web UI is React 19, built once with Vite (`npm ci && npm run build`); the Docker image does this for you.

## Deploy on openmediavault (Docker)

The image is multi-arch for 64-bit systems: x86-64 and ARM64 (e.g. a Raspberry Pi with a 64-bit OS). 32-bit ARM (`arm/v7`) is not supported because Node.js 26 no longer provides it. It runs as an unprivileged user with a read-only filesystem and no capabilities, and contains no secrets.

1. Clone the repository on the NAS, e.g. `git clone https://github.com/mRgAmEwAtCh/media-renamer.git /srv/dev-disk-by-uuid-…/appdata/media-renamer`.
2. Create `.env` next to `compose.yaml` from `.env.example` and fill in:
   - `MEDIA_PATH`: shared folder with incoming files, mounted at `/media`.
   - `LIBRARY_PATH`: shared folder to move renamed files into, mounted at `/library`. It may be on another disk.
   - `MEDIA_RENAMER_TV_TARGET` / `MEDIA_RENAMER_MOVIE_TARGET`: where TV episodes and movies go inside the container, e.g. `/library/TV` and `/library/Movies`. You can also set them later in the web UI.
   - `PUID` / `PGID`: owner of the media files (run `id <user>` on the NAS). OMV's `users` group is usually `100`.
   - `MEDIA_RENAMER_PASSWORD`, `MEDIA_RENAMER_ALLOWED_HOSTS`, and optionally `TMDB_API_KEY`.

   **Single mount for instant moves.** Two bind mounts are separate filesystems to Linux, even on the same disk, so moving from `/media` to `/library` copies the file. If your downloads and libraries share a disk or a mergerfs pool, mount the common parent once and list the shares instead:
   ```bash
   MEDIA_PATH=/srv/mergerfs/Pool          # leave LIBRARY_PATH unset
   MEDIA_RENAMER_ROOTS=/media/Downloads,/media/TV,/media/Movies
   MEDIA_RENAMER_TV_TARGET=/media/TV
   MEDIA_RENAMER_MOVIE_TARGET=/media/Movies
   ```
3. Start it.
   - **Prebuilt image (no build on the NAS):** set `MEDIA_RENAMER_IMAGE=ghcr.io/mrgamewatch/media-renamer:latest` in `.env`, then `mkdir -p config && docker compose pull && docker compose up -d`. `latest` is the newest release; use a release number such as `0.8` to stay on one version, or `main` for the current development state. To try a pull request before it is merged, use `pr-<number>` (e.g. `pr-12`); each push to a pull request from this repository updates that image, and the CI run's summary shows the exact pull command.
   - **Build locally over SSH:** `mkdir -p config && docker compose up -d --build` in that folder.
   - **OMV web UI** (Services → Compose → Files): paste `compose.yaml` and the `.env` contents. The compose plugin needs the image to exist or a build context, so either set `MEDIA_RENAMER_IMAGE` to the prebuilt image or build once over SSH (or `docker build -t media-renamer:latest .`).
4. Open `http://<nas>:4173/`, log in with your password, and click **Browse…**. Only the folders in `MEDIA_RENAMER_ROOTS` are visible.

**Updating:** with the prebuilt image, `docker compose pull && docker compose up -d`; when building locally, `git pull && docker compose up -d --build`. Your `.env` and `config/` are not tracked by git, so updates never touch them.

**Releases:** pushing a tag such as `v0.9` or `v1.10` runs the tests and publishes the image as `0.9` / `1.10` and `latest` for `linux/amd64` and `linux/arm64`. Every push to `main` publishes `main`.

The CLI is available inside the container and uses the same configuration:

```bash
docker compose exec media-renamer media-renamer apply /media --dry-run --format tsv
docker compose run --rm media-renamer preview /media/TV --format jsonl
```

Health check: `GET /healthz` (no authentication). `docker stop` shuts the server down cleanly.

## Configuration

All settings come from the environment, a `.env` file next to the app, or the file named by `MEDIA_RENAMER_ENV_FILE`. Real environment variables win over the file. **Secrets are never accepted from the browser or as command-line flags.** Flags would leak into shell history and process lists, and the browser would store them. `.env` is ignored by git and excluded from the Docker image.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TMDB_API_KEY` / `TMDB_API_KEY_FILE` | — | TMDB API key or v4 read token for movie lookups. `_FILE` reads it from a file (Docker secrets). |
| `MEDIA_RENAMER_TV_TARGET` | — | Default destination for TV episodes. Empty means rename episodes in place. CLI: `--tv-target`. |
| `MEDIA_RENAMER_MOVIE_TARGET` | — | Default destination for movies. Empty means rename movies in place. CLI: `--movie-target`. |
| `MEDIA_RENAMER_TARGET` | — | Default destination for both kinds when the two variables above are not set. CLI: `--target`. |
| `MEDIA_RENAMER_EPISODE_PATTERN` | `{n} - {s00e00} - {t}` | Default episode pattern. CLI: `--episode-pattern`. |
| `MEDIA_RENAMER_MOVIE_PATTERN` | `{n} ({y})` | Default movie pattern. CLI: `--movie-pattern`. |
| `MEDIA_RENAMER_CONFIG_DIR` | per-user config folder (`/config` in Docker) | Where saved settings (`settings.json`) and the job history (`jobs.json`) are kept. |
| `MEDIA_RENAMER_HOOK_TOKEN` / `_FILE` | — | Enables the automatic import hook; callers send it as a Bearer token. Use at least 20 random characters. |
| `MEDIA_RENAMER_PATH_MAP` | — | Translates paths sent to the hook, e.g. `/Downloads=/media/Downloads`. Comma-separated for several. |
| `MEDIA_RENAMER_STABLE_SECONDS` | `10` | How long files must stop changing before an import starts. |
| `MEDIA_RENAMER_AUTO_IMPORT` | `true` | Whether the hook imports at all. |
| `MEDIA_RENAMER_AUTO_INCLUDE_WARNINGS` | `false` | Also import files without a confident match. |
| `MEDIA_RENAMER_CLEANUP_EMPTY_FOLDERS` | `false` | Remove extraction folders left empty after an import. |
| `MEDIA_RENAMER_AUDIO_FIX` | `false` | Add a Dolby Digital Plus track to DTS-only movies during imports. |
| `MEDIA_RENAMER_AUDIO_FIX_EPISODES` | `false` | Do the same for TV episodes. |
| `MEDIA_RENAMER_AUDIO_LANGUAGES` | metadata language (e.g. `de`) | Comma-separated languages whose audio is checked. |
| `MEDIA_RENAMER_AUDIO_BITRATE` | `1024k` | Bitrate of the added 5.1 track (192k–1536k; stereo uses 256k). |
| `MEDIA_RENAMER_FFMPEG` / `MEDIA_RENAMER_FFPROBE` | from `PATH` | ffmpeg and ffprobe to use (included in the Docker image). |
| `MEDIA_RENAMER_VIDEO_ONLY` | `false` | Only process video files (skip subtitles) by default. CLI: `--video-only` / `--all-types`. |
| `MEDIA_RENAMER_INCLUDE_SAMPLES` | `false` | Keep release samples by default instead of skipping them. CLI: `--include-samples`. |
| `MEDIA_RENAMER_LANGUAGE` | `en-US` | Metadata language for TMDB, e.g. `de-DE`. CLI: `--language`; the web UI pre-fills it. |
| `MEDIA_RENAMER_REGION` | — | Release country used when matching movies on TMDB, e.g. `DE`. CLI: `--region`. |
| `MEDIA_RENAMER_SHUTDOWN_GRACE` | `8` (`570` in compose) | Seconds a running job may finish its current file when the server stops. Keep it below Docker's `stop_grace_period`. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Address the web server listens on. |
| `PORT` | `4173` | Web server port. |
| `MEDIA_RENAMER_ROOTS` | — (`/media,/library` in compose) | Comma-separated folders the web UI may browse, rename and move in. Symlinks cannot escape them, and the system folder dialog is disabled when set. In Docker, set it in `.env` for a single-mount setup (see below). |
| `MEDIA_RENAMER_ALLOWED_HOSTS` | loopback only | Comma-separated hostnames/IPs accepted in the `Host` header (blocks DNS rebinding). Use `*` to accept any; that is also the default when listening on a non-loopback address. |
| `MEDIA_RENAMER_PASSWORD` / `_FILE` | — | Require this password on a login page (scripts can use Basic auth, e.g. `curl -u any:<password>`). Strongly recommended on a network. |
| `UMASK` | system | Octal umask for folders created by renames, e.g. `002`. |

The server warns at startup when it listens on the network without a password, allowed hosts, or root folders.

### Saved settings

The web UI's **Save** stores the naming patterns, the TV and movie destinations, the move switch, language, region, filters and the automatic-import options in `settings.json` in `MEDIA_RENAMER_CONFIG_DIR`. These are used by the web UI on every device, by automatic imports and by the CLI. **Reset to server defaults** deletes the file.

Precedence, lowest to highest: built-in defaults → environment variables → saved settings → per-run choices (web UI fields before previewing, CLI flags). `media-renamer settings` prints the result. In Docker, `./config` is mounted at `/config`; create it before the first start (`mkdir -p config`) so it belongs to `PUID`, otherwise saving fails with a clear error.

## Long moves, progress and safety

All renaming and moving runs on the machine where the server or CLI runs: the NAS when using Docker. The browser only sends the request and shows progress.

When the destination is on another disk (common with mergerfs pools whose shares live on different disks), a move is a copy at disk speed. To keep that safe:

- **Background jobs.** In the web UI, renames and undos run as jobs on the server, one at a time. A progress panel shows files and bytes done, speed and time left. You can close the page; reopening it picks the job up again. The CLI shows the same progress on stderr.
- **No half-written files.** A file is copied to a hidden `.media-renamer-partial-…` file next to the target, synced to disk, size-checked, and only then given its final name, never overwriting an existing file. Only then is the original deleted.
- **Cancel.** The **Cancel** button, or Ctrl-C in the CLI (exit code 130), stops during the current file. The partial copy is deleted and that file stays where it was. Files already moved stay moved and can be undone.
- **Undo journal.** Each file is written to `<source>/.media-renamer-undo.json` before it moves and marked done right after. A batch that was cancelled, failed partway or was cut off by a crash can still be undone. A failing file is reported and the rest of the batch continues.
- **Stopping the container.** `docker stop` lets the current file finish (up to `MEDIA_RENAMER_SHUTDOWN_GRACE`, with `stop_grace_period: 10m` in compose) and doesn't start the next one.
- **Crash recovery.** After a hard crash or power loss, the next job in that folder marks the batch as interrupted and deletes its partial copy. A lock file prevents two jobs (web UI and CLI, or two browser tabs) from working in the same folder; a lock left by a crashed process is detected and taken over. The fixed container `hostname` in compose makes that immediate after a restart.

## Language and region

`MEDIA_RENAMER_LANGUAGE` (e.g. `de-DE`) and `MEDIA_RENAMER_REGION` (e.g. `DE`) set the defaults. Override them in the web UI's Naming section, or per CLI run with `--language` / `--region`.

- **Movies** are searched on TMDB in that language, so titles come back localized (e.g. *Der Pate*). With a region, release-specific matches are tried first, then a global search.
- **TV shows** also use TMDB when a key is configured, which gives localized series and episode titles. If TMDB only has a placeholder episode name such as "Folge 3", the English title is used. Shows TMDB doesn't know fall back to TVmaze.
- **Without a TMDB key**, TV titles come from TVmaze, which is English only, and movies keep their parsed names.
- `{on}` inserts the original title, e.g. `{n} [{on}] ({y})` → `Der Pate [The Godfather] (1972)`.

## Automatic import from a downloader

A downloader can hand finished downloads to Media Renamer, which then imports them on its own:

```bash
curl -fsS -X POST http://127.0.0.1:4173/api/hooks/extracted \
  -H "Authorization: Bearer $MEDIA_RENAMER_HOOK_TOKEN" \
  --data-urlencode "ARCHIVE_PATH=/Downloads/extracted/Some.Movie.2024"
```

The hook accepts a folder or a file, as the `ARCHIVE_PATH` form field or as JSON `{"path": "…"}`, and answers `202` with the job straight away. It is enabled by `MEDIA_RENAMER_HOOK_TOKEN` and needs only that token, not the web password. It can only import inside `MEDIA_RENAMER_ROOTS`. If the downloader sees the files under different paths, `MEDIA_RENAMER_PATH_MAP` translates them (for JDownloader: `/Downloads=/media/Downloads`).

**JDownloader** (Event Scripter, trigger *Archive extraction finished*):

```js
var path = archive.getExtractToFolder();
callAsync(function () {}, 'curl', '-fsS', '-X', 'POST', '-H', 'Authorization: Bearer YOUR_TOKEN',
  '--data-urlencode', 'ARCHIVE_PATH=' + path, 'http://127.0.0.1:4173/api/hooks/extracted');
```

Each import runs these steps, all shown live in the web UI's **Activity** view:

1. **Wait** until the files stop changing (`MEDIA_RENAMER_STABLE_SECONDS`).
2. **Scan** with the saved filters (video only, skip samples).
3. **Look up metadata** with the saved patterns, language and TV/movie destinations.
4. **Decide.** Only confident matches (status `ok`) are imported. Everything else stays where it is and is listed as *Needs review*. **Resolve** opens just those files, already previewed, in the Rename view (see [Reviewing imports](#reviewing-imports)).
5. **Check audio** (optional, `.mkv` only).
6. **Convert and move** with the normal engine: journalled, undoable, with progress and **Cancel**.
7. **Clean up** extraction folders left empty (optional).

Imports run one at a time, after any rename already running. A second call for a folder that is already waiting joins that job. The queue and the history (the last 50 finished jobs) are saved in `jobs.json` in the config folder, so the Activity view survives restarts: an import waiting or running when the server stops runs again after the restart. **Clear history** in the Activity view removes the finished jobs; waiting and running jobs stay, and undo is not affected. Imports can be undone with **Undo last batch** on the allowed folder that contains them (e.g. `/media/Downloads`).

### Notifications

Click **🔕 Notify me** in the Activity view and allow notifications to get a push notification on that device when an import has files that need review or a job fails, even when the page is closed. Tapping a *needs review* notification opens that import's files ready to resolve; a failure opens the Activity view. Click it again to stop. Each browser or phone subscribes separately.

- Browsers allow this only over HTTPS (for example behind a reverse proxy) or on `localhost`; on plain `http://<nas>:4173` the button is not shown.
- On iPhone/iPad (iOS 16.4+), first add the app to the home screen and open it from there.
- The server needs outgoing internet access to the browsers' push services. Its keys and the subscriptions are stored in `push.json` in the config folder.

### Audio fix: Dolby Digital Plus next to DTS

Many TVs, soundbars and apps cannot play DTS. When the audio fix is on, every imported movie (and, optionally, episode) is checked with ffprobe. For each configured language that has a DTS track but no Dolby track (AC3, E-AC-3 or TrueHD), an **E-AC-3 (Dolby Digital Plus) 5.1** track is added in that language, labelled *converted from DTS*.

- All original tracks, including the DTS track, are copied unchanged; only the new track is encoded.
- ffmpeg writes straight into a hidden partial file in the destination. The file gets its final name only after the result has been checked (track count, codec, duration), and only then is the download copy deleted. A failed or cancelled conversion leaves the original untouched.
- 7.1 sources are downmixed to 5.1 for the new track, because ffmpeg's E-AC-3 encoder supports at most 5.1.
- Dolby Atmos cannot be created with open-source tools; existing Atmos tracks (TrueHD or E-AC-3) are kept as they are.

The options are in the web UI under **Automatic import** (saved with **Save**), or set by the `MEDIA_RENAMER_AUDIO_*` variables.

## Web app

```bash
npm ci && npm run build        # once, and after changing web/: builds the web UI into dist/web
npm start                      # or: node bin/media-renamer.ts serve --port 4173
open http://127.0.0.1:4173/
```

While working on the web UI, run `npm start` and `npm run dev` side by side and open the address Vite prints: it reloads on every change and forwards API calls to the server on port 4173. Restart `npm start` after a new `npm run build`, since the server indexes the build once.

The page has three views, linked in the header and in the address bar (`#/rename`, `#/activity`, `#/settings`), so Back works and links can be bookmarked:

- **Rename**: the *Needs review* inbox, the folder, and the file table. A line under the folder shows where files go, with a link to Settings.
- **Activity**: running and finished jobs. Finished jobs are collapsed; click anywhere on a card or use its chevron to expand or collapse the steps and file overview. Running jobs start expanded. Files are shown directly, without a second toggle. Resolve and Cancel remain independent actions. Filter by **Needs review** or **Failed**, 10 at a time with **Show more**. The tab shows a yellow counter for imports that need review and a pulsing blue dot while a job runs.
- Cards with no steps, files, notes or live progress have no chevron or expand/collapse interaction.
- **Settings**: naming patterns, destinations, language, filters and automatic import.

Language and Region use native dropdowns (including the phone's system picker). Choose **Custom language…** or **Custom region…** to enter a code not in the list; existing custom codes are preserved. Region also offers **No region preference**.

Rename and Settings actions stay docked to the bottom of the viewport. The page reserves their height, including the phone's safe area, so files and credits remain reachable. Status messages scroll with the page instead of increasing the dock's height.

Settings changed but not saved are marked with a yellow dot on the tab. Leaving Settings, or previewing with changed naming or destination settings, asks to **Save**, **Discard changes** or **Keep editing**, so previews never silently differ from what imports use.

1. Click **Browse…** to choose the folder to rename, or type a path and click **Scan & preview** (or press Enter). Choosing a folder scans and previews automatically. Changing the folder filters takes effect on the next scan, without replacing the current edits.
2. In **Settings**, under **Naming & destinations**, set the episode and movie patterns. To move files into your libraries, tick **Move renamed files into my library folders** and choose a destination for TV shows and one for movies, each with its own **Browse…** button. Leave one empty to rename that kind in place. **Save** keeps these settings for next time.
3. Review the proposed names. Each file shows which library it goes to. Matched files are selected automatically; warnings must be selected by hand. You can edit any new name before applying. **Preview again** refreshes the names without scanning again; replacing edited names, selections or conflict decisions asks for confirmation. If metadata lookup fails, the scanned files remain available with **Retry preview**. Scanning and metadata lookup show separate progress messages, including skipped-file counts and truncated-list warnings.
   If a new name is taken, by a file already in the library or by another file in the list, the row shows the sizes of both files and offers **Keep both** (the new file gets “(2)” added), **Overwrite** (replaces the existing file) or **Skip**, which can also delete the extracted file, e.g. a lower-quality copy. Replaced and deleted files cannot be restored with **Undo last batch**.
   **Only files that need attention** hides the rows that are fine; **Keep both for all N conflicts** and **Skip all conflicts** settle every conflict at once.
4. Click **Rename selected** (or **Rename & move selected**). A progress panel with **Cancel** appears while the server works. If you change a destination after previewing, you must preview again. **Undo last batch** moves files back from both libraries.

### Reviewing imports

Imports that left files for review are listed under **Needs review** on the Rename view and marked in Activity. **Resolve** (or a notification) previews just those files with the saved settings and jumps to the first conflict or warning: no scan, no extra Preview. Rename some, and the rest are previewed again; once none are left, or after **Mark as reviewed**, the import leaves the inbox. **Dismiss** removes it without changes. Files already moved elsewhere are dropped from the review. Which imports were reviewed is remembered per browser.

### Choosing folders

Browsers don't give web pages the real filesystem path of a picked folder, so the server provides the folder browser:

- **Built-in browser.** Works the same on Windows, macOS and Linux. It shows quick places (Home, Desktop, Downloads, Videos/Movies, plus drive letters on Windows, `/Volumes` on macOS, and `/media`, `/run/media` and `/mnt` on Linux, or only `MEDIA_RENAMER_ROOTS` when set), breadcrumbs, a path bar you can type into, and how many media files the folder contains. Use the arrow keys to move through folders and Backspace to go up.
- **System dialog….** Opens the operating system's folder picker on the machine running the server: AppleScript on macOS, PowerShell on Windows, and `zenity` or `kdialog` on Linux. It is hidden when no dialog is available, e.g. in Docker.

## CLI

```bash
npm link                       # optional: puts `media-renamer` on PATH
media-renamer --help
```

| Command | Purpose |
| --- | --- |
| `scan <dir>` | List media files and what was parsed from their names |
| `preview <dir> [file...]` | Look up metadata and print proposed names. Changes nothing. |
| `apply <dir> [file...]` | Preview, then rename or move items with status `ok` |
| `apply <dir> --plan <file\|->` | Apply a plan produced by `preview --format json\|jsonl` |
| `undo <dir>` | Reverse the last batch, including moves |
| `settings` | Show the effective defaults and where `settings.json` is |
| `import <dir>` | Run the automatic import on a folder (`--audio-fix`, `--no-audio-fix`, `--cleanup`, `--wait <s>`, `--dry-run`) |
| `pick [--start <dir>]` | Open the system folder dialog and print the chosen path |
| `serve [--port n]` | Start the web app |

### Filters

- **Video files only** (`--video-only`, or `MEDIA_RENAMER_VIDEO_ONLY=true`): process only video files (`.mkv`, `.mp4`, `.avi`, `.m4v`, `.ts`, `.m2ts`, `.mov`, `.wmv`, `.webm`, `.mpg`, `.vob`, …) and skip subtitles. `--all-types` overrides the environment default.
- **Skip sample files** (on by default; `--include-samples` or `MEDIA_RENAMER_INCLUDE_SAMPLES=true` to keep them): skips `Sample`/`Samples` folders entirely and files with `sample` as a separate word in the name, such as `sample.mkv`, `movie-sample.mkv` or `Movie.2010.SAMPLE.mkv`. Titles like `The.Samples.2015.mkv` are not affected.

Scans report how many files were skipped. Files passed as arguments or on stdin are filtered too and appear with status `skipped` and the reason. The web UI has the same two checkboxes; their defaults come from the saved settings or the environment.

### Moving to a destination

TV episodes and movies can go to different folders: `--tv-target <dir>` and `--movie-target <dir>`, or `-t, --target <dir>` for both. Without flags, the saved settings or the `MEDIA_RENAMER_TV_TARGET` / `MEDIA_RENAMER_MOVIE_TARGET` / `MEDIA_RENAMER_TARGET` variables are used. An empty value (e.g. `--movie-target ''`) renames that kind in place.

- Files moved into a destination start at its root: download folder names such as `extracted/…` are not carried over. Use `/` in a pattern to create folders, e.g. `{n}/Season {s}/{s00e00} {t}`. Files renamed in place keep their subfolder.
- Every preview item and rename record carries its own `target`; `newRel`/`to` are relative to it. Use `--absolute` for full paths. TSV output has the destination as its last column (empty for in-place renames).
- Moves across disks or Docker bind mounts copy the file, verify its size, keep its permissions and modification time, then delete the original. Existing files are never overwritten.
- `preview --format json` records each item's destination in the plan. `apply --plan` uses it and refuses explicit target flags that disagree.

```bash
media-renamer apply ~/Downloads --tv-target ~/Media/TV --movie-target ~/Media/Movies \
  --episode-pattern '{n}/Season {s}/{n} - {s00e00} - {t}' --movie-pattern '{n} ({y})/{n} ({y})'

media-renamer preview /media --format json > plan.json
media-renamer apply /media --plan plan.json
```

### Pipeline conventions

- **stdout carries data only.** Progress goes to stderr; use `-q` to silence it.
- `--format table|json|jsonl|tsv`. The default is `table` on a terminal and `json` when piped.
- `--stdin` reads file paths from stdin. Add `-0`/`--null` for NUL-separated input and TSV output.
- `--include-warnings` also applies items matched only by their parsed name. `--strict` refuses to apply, and exits 3, if any item is an error or conflict. `--dry-run` shows what `apply` would do.
- **Exit codes:** `0` success, `1` error, `2` usage error, `3` finished with unresolved or failed items, `130` cancelled with Ctrl-C.

```bash
media-renamer preview ~/TV --format jsonl | jq -c 'select(.match != null)' | media-renamer apply ~/TV --plan -
find ~/Downloads -name '*.mkv' -print0 | media-renamer preview ~/Downloads --stdin -0 --format tsv -0
media-renamer preview "$(media-renamer pick)"
```

Each preview item has the shape `{ rel, kind, newRel, target, status, match, message }`, where `status` is one of `ok`, `warning`, `unchanged`, `skipped`, `conflict` or `error`.

## Naming patterns

| Token | Meaning | Example |
| --- | --- | --- |
| `{n}` | Series or movie name | `Breaking Bad` |
| `{y}` | Year | `2008` |
| `{s}` / `{s00}` | Season | `1` / `01` |
| `{e}` / `{e00}` | Episode | `2` / `02` |
| `{s00e00}` | Season and episode, including ranges | `S01E02`, `S01E02-E03` |
| `{sxe}` | Alternative form | `1x02` |
| `{t}` | Episode title | `Cat's in the Bag` |
| `{d}` | Air date | `2008-01-27` |
| `{on}` | Original title (from TMDB) | `The Godfather` |

Defaults are `{n} - {s00e00} - {t}` for episodes and `{n} ({y})` for movies. Unsafe characters are removed, `:` becomes ` - `, and empty `()`/`[]` from missing values are dropped. Subtitle language suffixes such as `.en.srt` are preserved.

## Code layout

| Path | Contents |
| --- | --- |
| `server.ts` | Web server: request handling, login, startup and shutdown |
| `bin/media-renamer.ts` | CLI entry point; dispatches to `lib/cli/` |
| `lib/renamer.ts` | Public API of the rename engine; the parts live in `lib/rename/` (scan, preview, lock, undo journal, apply, undo) |
| `lib/settings.ts` | Public API of the settings; the parts live in `lib/settings/` (environment defaults, validation, saved file) |
| `lib/server/` | Routes grouped by area (`routes/`), the import hook, static files, HTTP helpers and the folder policy |
| `lib/cli/` | Help text, argument parsing, output formats, plans and the commands |
| `lib/types.ts`, `lib/job-types.ts` | Shared data types: settings, preview items, the undo journal; jobs and imports |
| `lib/api-types.ts` | The HTTP API: request and response of every `/api/…` route, used by the server and the web UI |
| `lib/importer.ts`, `lib/jobs.ts` | Automatic import pipeline and the background job queue |
| `lib/parse.ts`, `lib/format.ts`, `lib/metadata.ts` | File-name parsing, naming patterns, TMDB/TVmaze lookups |
| `lib/mover.ts`, `lib/audio.ts` | Safe moves across disks, and the Dolby Digital Plus audio fix |
| `web/` | Web UI (React 19, Vite): `index.html` and `login.html`; `public/` holds icons, the manifest and the service worker, copied as they are |
| `web/src/` | `App.tsx` switches between the views (`route.ts`) and wires the review flow (`review.ts`); `hooks/` hold the logic (settings form, rename workflow, activity polling, notifications) and `components/` the panels, file table and folder picker |
| `vite.config.ts` | Builds `web/` into `dist/web` |

The server serves only the files in `dist/web`. The login page, the files it needs (read from Vite's manifest) and the top-level files from `web/public` load without logging in; everything else requires it.

## Tests

```bash
npm ci                 # dev tools: TypeScript, Vite, React
npm run typecheck      # tsc over the backend (tsconfig.json) and the web UI (web/tsconfig.json)
npm run build          # the web UI
npm test
```

The tests don't need a build: they serve a small stand-in (`test/web-fixture.js`). The backend only uses TypeScript syntax that Node can strip (no `enum`, `namespace` or constructor parameter properties; `erasableSyntaxOnly` enforces this). Relative imports keep their `.ts` extension.

Tests replace metadata lookups with fakes and use temporary folders, so they make no network calls. They cover parsing, patterns, moves and the cross-device fallback, the CLI, configuration, and the server's authentication, Host check and folder confinement.

## Credits and data sources

- **TMDB.** This product uses the TMDB API but is not endorsed or certified by TMDB. Movie data and localized titles come from [The Movie Database](https://www.themoviedb.org/). Using it requires your own API key and acceptance of the [TMDB API terms](https://www.themoviedb.org/api-terms-of-use).
- **TVmaze.** TV show and episode data come from the [TVmaze API](https://www.tvmaze.com/api), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Media Renamer only looks up metadata and renames files; it does not store or redistribute TMDB or TVmaze data.

## License

[MIT](LICENSE)
