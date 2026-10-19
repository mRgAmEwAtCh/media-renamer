# Media Renamer

Rename movie and TV episode files from public metadata and optionally move them into a library folder. It has a web app and a pipeline-friendly CLI, which share the same core in `lib/`. It runs locally or in Docker, for example on an openmediavault NAS.

- **TV episodes** are matched on [TVmaze](https://www.tvmaze.com/api) (no key needed).
- **Movies** are matched on [TMDB](https://developer.themoviedb.org/) with an API key from the server configuration. Without a key, movies keep the name and year parsed from the file name and are marked as warnings.
- Every rename is previewed first and validated to stay inside the allowed folders. A batch is applied all-or-nothing and recorded in `<source>/.media-renamer-undo.json` so it can be undone.

Requires Node.js 22 or newer and has no npm dependencies.

## Deploy on openmediavault (Docker)

The image is multi-arch (x86-64 and ARM, e.g. Raspberry Pi). It runs as an unprivileged user with a read-only filesystem and no capabilities, and contains no secrets.

1. Copy this folder to the NAS, e.g. `/srv/dev-disk-by-uuid-…/appdata/media-renamer`.
2. Create `.env` next to `compose.yaml` from `.env.example` and fill in:
   - `MEDIA_PATH`: shared folder with incoming files, mounted at `/media`.
   - `LIBRARY_PATH`: shared folder to move renamed files into, mounted at `/library`. It may be on another disk.
   - `MEDIA_RENAMER_TV_TARGET` / `MEDIA_RENAMER_MOVIE_TARGET`: where TV episodes and movies go inside the container, e.g. `/library/TV` and `/library/Movies`. You can also set them later in the web UI.
   - `PUID` / `PGID`: owner of the media files (run `id <user>` on the NAS). OMV's `users` group is usually `100`.
   - `MEDIA_RENAMER_PASSWORD`, `MEDIA_RENAMER_ALLOWED_HOSTS`, and optionally `TMDB_API_KEY`.
3. Start it.
   - **SSH:** `mkdir -p config && docker compose up -d --build` in that folder.
   - **OMV web UI** (Services → Compose → Files): paste `compose.yaml` and the `.env` contents. The compose plugin needs the image to exist or a build context, so building once over SSH (or `docker build -t media-renamer:latest .`) is simplest.
4. Open `http://<nas>:4173/`, log in with any user name and your password, and click **Browse…**. Only `/media` and `/library` are visible.

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
| `MEDIA_RENAMER_CONFIG_DIR` | per-user config folder (`/config` in Docker) | Where saved settings (`settings.json`) are kept. |
| `MEDIA_RENAMER_VIDEO_ONLY` | `false` | Only process video files (skip subtitles) by default. CLI: `--video-only` / `--all-types`. |
| `MEDIA_RENAMER_INCLUDE_SAMPLES` | `false` | Keep release samples by default instead of skipping them. CLI: `--include-samples`. |
| `MEDIA_RENAMER_LANGUAGE` | `en-US` | Metadata language for TMDB, e.g. `de-DE`. CLI: `--language`; the web UI pre-fills it. |
| `MEDIA_RENAMER_REGION` | — | Release country used when matching movies on TMDB, e.g. `DE`. CLI: `--region`. |
| `MEDIA_RENAMER_SHUTDOWN_GRACE` | `8` (`570` in compose) | Seconds a running job may finish its current file when the server stops. Keep it below Docker's `stop_grace_period`. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Address the web server listens on. |
| `PORT` | `4173` | Web server port. |
| `MEDIA_RENAMER_ROOTS` | — (`/media,/library` in compose) | Comma-separated folders the web UI may browse, rename and move in. Symlinks cannot escape them, and the system folder dialog is disabled when set. |
| `MEDIA_RENAMER_ALLOWED_HOSTS` | loopback only | Comma-separated hostnames/IPs accepted in the `Host` header (blocks DNS rebinding). Use `*` to accept any; that is also the default when listening on a non-loopback address. |
| `MEDIA_RENAMER_PASSWORD` / `_FILE` | — | Require HTTP Basic auth (any user name). Strongly recommended on a network. |
| `UMASK` | system | Octal umask for folders created by renames, e.g. `002`. |

The server warns at startup when it listens on the network without a password, allowed hosts, or root folders.

### Saved settings

The web UI's **Save as default** stores the naming patterns, the TV and movie destinations, the move switch, language, region and filters in `settings.json` in `MEDIA_RENAMER_CONFIG_DIR`. These are used by the web UI on every device and by the CLI. **Reset to server defaults** deletes the file.

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

## Web app

```bash
npm start                      # or: node bin/media-renamer.js serve --port 4173
open http://127.0.0.1:4173/
```

1. Click **Browse…** to choose the folder to rename, or type a path. Choosing a folder starts the scan.
2. Under **Naming & destinations**, set the episode and movie patterns. To move files into your libraries, tick **Move renamed files into my library folders** and choose a destination for TV shows and one for movies, each with its own **Browse…** button. Leave one empty to rename that kind in place. **Save as default** keeps these settings for next time.
3. Click **Preview names**. Each file shows which library it goes to. Matched files are selected automatically; warnings must be selected by hand. You can edit any new name before applying.
4. Click **Rename selected** (or **Rename & move selected**). A progress panel with **Cancel** appears while the server works. If you change a destination after previewing, you must preview again. **Undo last batch** moves files back from both libraries.

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

## Tests

```bash
npm test
```

Tests replace metadata lookups with fakes and use temporary folders, so they make no network calls. They cover parsing, patterns, moves and the cross-device fallback, the CLI, configuration, and the server's authentication, Host check and folder confinement.

## Credits and data sources

- **TMDB.** This product uses the TMDB API but is not endorsed or certified by TMDB. Movie data and localized titles come from [The Movie Database](https://www.themoviedb.org/). Using it requires your own API key and acceptance of the [TMDB API terms](https://www.themoviedb.org/api-terms-of-use).
- **TVmaze.** TV show and episode data come from the [TVmaze API](https://www.tvmaze.com/api), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Media Renamer only looks up metadata and renames files; it does not store or redistribute TMDB or TVmaze data.

## License

[MIT](LICENSE)
