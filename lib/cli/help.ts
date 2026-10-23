import { DEFAULT_PATTERNS } from '../defaults.ts';
import { TOKEN_NAMES } from '../format.ts';

export const HELP = `media-renamer — rename movie and TV episode files from public metadata

Usage:
  media-renamer scan     <dir> [options]
  media-renamer preview  <dir> [file...] [options]
  media-renamer apply    <dir> [file...] [options]
  media-renamer apply    <dir> --plan <file|-> [options]
  media-renamer undo     <dir> [options]
  media-renamer import   <dir> [options]
  media-renamer settings [--format json]
  media-renamer pick     [--start <dir>]
  media-renamer serve    [--port <n>]

Commands:
  scan      List media files and what was parsed from their names
  preview   Look up metadata and print proposed names (changes nothing)
  apply     Rename files; uses a fresh preview, or a plan from --plan
  undo      Reverse the last applied batch in <dir>
  import    Run the automatic import on <dir>: scan, look up, optionally add
            Dolby Digital Plus tracks to DTS files, then rename and move. Only
            confident matches are moved; the rest is listed for review.
  settings  Show the effective defaults (saved settings over environment)
  pick      Open the system folder dialog and print the chosen path
            (macOS: AppleScript, Windows: PowerShell, Linux: zenity or kdialog)
  serve     Start the local web app on 127.0.0.1

Input:
  [file...]                 Files to process, relative to <dir> or absolute
  --stdin                   Read file paths from stdin (one per line)
  -0, --null                Records on stdin/output are NUL-separated
  --no-recursive            Do not descend into subfolders when scanning
  --plan <file|->           Apply a plan produced by "preview --format json|jsonl"

Filters (also applied to files given as arguments or on stdin):
  --video-only              Only process video files (.mkv, .mp4, .avi, …); skip subtitles
  --all-types               Process video and subtitle files (overrides the default)
  --include-samples         Do not skip release samples. By default "Sample(s)" folders and
                            files like movie-sample.mkv are skipped

Destination (TV episodes and movies can go to different folders):
  --tv-target <dir>         Move TV episodes into <dir>
  --movie-target <dir>      Move movies into <dir>
  -t, --target <dir>        Move both kinds into <dir>
                            An empty value ('') renames that kind in place.
                            Moved files start at the destination root; renamed-in-place
                            files keep their subfolder. Moves across disks/mounts copy,
                            verify, then delete.

Naming:
  --episode-pattern <p>     Built-in default: "${DEFAULT_PATTERNS.episode}"
  --movie-pattern <p>       Built-in default: "${DEFAULT_PATTERNS.movie}"
  --language <code>         Metadata language, e.g. de-DE, fr, en-US (built-in: en-US)
  --region <CC>             Release region for movie matching, e.g. DE
  Tokens: ${TOKEN_NAMES.map((t) => `{${t}}`).join(' ')}  ({on} = original title)
  A "/" in a pattern creates folders, e.g. "{n}/Season {s}/{s00e00} {t}".
  Localised TV titles need a TMDB key; without one TVmaze (English) is used.

Defaults (flags override them):
  Saved settings — written by the web UI's "Save as default" — override environment
  variables, which override built-ins. "media-renamer settings" shows the result.
  MEDIA_RENAMER_CONFIG_DIR       Folder of settings.json (default: per-user config folder)
  MEDIA_RENAMER_TV_TARGET        Default TV destination
  MEDIA_RENAMER_MOVIE_TARGET     Default movie destination
  MEDIA_RENAMER_TARGET           Default destination for both
  MEDIA_RENAMER_EPISODE_PATTERN  Default episode pattern
  MEDIA_RENAMER_MOVIE_PATTERN    Default movie pattern
  MEDIA_RENAMER_LANGUAGE / MEDIA_RENAMER_REGION
  MEDIA_RENAMER_VIDEO_ONLY / MEDIA_RENAMER_INCLUDE_SAMPLES

Secrets (environment only, never command-line flags):
  TMDB_API_KEY              TMDB API key or v4 read token for movie lookups
  TMDB_API_KEY_FILE         File containing the key (e.g. a Docker secret)
  MEDIA_RENAMER_ENV_FILE    KEY=value file to load (default: .env next to the app)

Behaviour:
  --include-warnings        Also apply/import items that only matched the parsed name
  --strict                  Exit 3 (and do not apply) if any item is an error or conflict
  --dry-run                 With apply/import: print what would happen, change nothing

Import (defaults come from the saved settings / environment):
  --audio-fix               Add Dolby Digital Plus (E-AC-3) tracks to DTS-only files
  --no-audio-fix            Do not convert audio for this run
  --cleanup                 Remove extraction folders left empty
  --wait <seconds>          Wait until files stop changing first (default 0)

Output:
  --format <f>              table | json | jsonl | tsv (default: table on a TTY, else json)
  --absolute                Print absolute paths instead of paths relative to <dir>
  -q, --quiet               No progress messages on stderr

Exit codes: 0 success, 1 error, 2 usage error, 3 completed with unresolved items,
            130 cancelled (Ctrl-C). Cancelling keeps the file being copied at its
            original location; files already moved can be undone.

Examples:
  media-renamer preview "$(media-renamer pick)"
  media-renamer apply ~/Downloads --tv-target ~/Media/TV --movie-target ~/Media/Movies \\
    --episode-pattern '{n}/Season {s}/{n} - {s00e00} - {t}' --movie-pattern '{n} ({y})/{n} ({y})'
  media-renamer preview ~/Downloads --format tsv
  find . -name '*.mkv' -print0 | media-renamer preview . --stdin -0 --format jsonl
  media-renamer preview ~/TV --format json > plan.json && media-renamer apply ~/TV --plan plan.json
  media-renamer preview ~/TV --format jsonl | jq -c 'select(.match != null)' | media-renamer apply ~/TV --plan -
`;
