// Data shapes shared by the rename engine, the importer, the job queue, the
// web server and the CLI. Type-only module: it has no runtime code.

export type MediaKind = 'episode' | 'movie';
export type ParsedKind = MediaKind | 'unknown';

/** What parseMediaFile reads from a file name (and its parent folders). */
export interface ParsedMedia {
  kind: ParsedKind;
  title: string;
  year: number | null;
  season?: number;
  episode?: number;
  episodeEnd?: number | null;
  extension: string;
  isSubtitle: boolean;
  /** Subtitle language suffix such as "en" in "Movie.en.srt". */
  language: string | null;
}

/* ---------- Settings ---------- */

export type Patterns = Record<MediaKind, string>;
/** Destination folder per kind; null renames that kind in place. */
export type Targets = Record<MediaKind, string | null>;

export interface Filters {
  videoOnly: boolean;
  excludeSamples: boolean;
}

export interface AudioFixSettings {
  enabled: boolean;
  episodes: boolean;
  /** 2- or 3-letter codes such as "de". */
  languages: string[];
  /** e.g. "1024k" */
  bitrate: string;
}

export interface AutomationSettings {
  enabled: boolean;
  includeWarnings: boolean;
  cleanupEmptyFolders: boolean;
  audioFix: AudioFixSettings;
}

export interface Settings {
  patterns: Patterns;
  targets: Targets;
  move: boolean;
  language: string;
  region: string | null;
  filters: Filters;
  automation: AutomationSettings;
}

/** Settings as saved by the web UI: every field is optional and overrides the environment. */
export interface SavedSettings {
  patterns?: Partial<Patterns>;
  targets?: Partial<Targets>;
  move?: boolean;
  language?: string;
  region?: string | null;
  filters?: Partial<Filters>;
  automation?: Partial<Omit<AutomationSettings, 'audioFix'>> & { audioFix?: Partial<AudioFixSettings> };
}

export interface SavedSettingsFile {
  exists: boolean;
  settings: SavedSettings;
  savedAt: string | null;
  problems: string[];
}

/* ---------- Metadata ---------- */

export interface ShowMatch {
  source: 'TMDB' | 'TVmaze';
  id: number;
  name: string;
  originalName: string | null;
  year: number | null;
  url?: string;
}

export interface EpisodeMatch {
  title: string;
  airdate: string | null;
}

export interface MovieMatch {
  source: 'TMDB';
  id: number;
  name: string;
  originalName: string | null;
  year: number | null;
}

/** The lookups the preview needs; MetadataClient implements it, tests pass fakes. */
export interface MetadataSource {
  tmdbKey?: string;
  findShow(name: string, year: number | null): Promise<ShowMatch | null>;
  findEpisode(show: ShowMatch, season: number | undefined, episode: number | undefined): Promise<EpisodeMatch | null>;
  findMovie(title: string, year: number | null): Promise<MovieMatch | null>;
}

/* ---------- Preview ---------- */

export type ItemStatus = 'ok' | 'warning' | 'skipped' | 'error' | 'conflict' | 'unchanged' | 'edited' | 'pending';

/** One file in a preview. `newRel` is relative to `target`, or to the root when renamed in place. */
export interface PreviewItem {
  rel: string;
  kind: ParsedKind;
  newRel: string | null;
  target: string | null;
  status: ItemStatus;
  match: string | null;
  message: string | null;
}

/* ---------- Audio fix ---------- */

export interface AudioConversion {
  streamIndex: number;
  language: string;
  channels: number;
  outputChannels: number;
  source: string;
}

export interface AudioPlan {
  action: 'convert' | 'skip';
  reason: string | null;
  conversions: AudioConversion[];
  audioCount: number;
  duration: number | null;
}

export interface AudioTools {
  ffmpeg: string;
  ffprobe: string;
}

/* ---------- Apply and undo ---------- */

export interface RenameRequest {
  from: string;
  to: string;
  /** Absolute destination folder; null or missing renames in place. */
  target?: string | null;
  audio?: AudioPlan | null;
}

export interface Progress {
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  current: {
    from: string;
    to: string;
    bytesDone: number;
    bytesTotal: number;
    phase: 'moving' | 'converting';
  } | null;
}

export type ProgressListener = (progress: Progress) => void;

export interface DoneRename {
  from: string;
  to: string;
  target: string | null;
  converted?: boolean;
}

export interface FailedRename extends DoneRename {
  reason: string;
}

export interface ApplyResult {
  renamed: number;
  failed: FailedRename[];
  cancelled: boolean;
  /** The one destination shared by all moves, or null. */
  target: string | null;
  targets: string[];
  renames: DoneRename[];
}

export interface UndoResult {
  restored: number;
  skipped: FailedRename[];
  cancelled: boolean;
  /** Entries still to restore after a cancel. */
  remaining: number;
  renames: DoneRename[];
  batchAt: string;
  target: string | null;
  targets: string[];
}

/* ---------- Undo journal ---------- */

export interface JournalEntry {
  from: string;
  to: string;
  target?: string;
  state: 'pending' | 'done' | 'undone';
  /** Name of the partial copy while the move is in progress. */
  partial?: string;
  converted?: boolean;
}

export interface JournalBatch {
  id: string;
  at: string;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'interrupted';
  /** Older batches recorded one destination for the whole batch. */
  target?: string;
  renames: JournalEntry[];
}

/* ---------- Jobs ---------- */

export type JobKind = 'apply' | 'undo' | 'import';
export type JobState = 'queued' | 'running' | 'cancelling' | 'finished' | 'cancelled' | 'failed' | 'interrupted';
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'stopped';

export interface StepDefinition {
  id: string;
  label: string;
}

export interface Step extends StepDefinition {
  state: StepState;
  detail: string | null;
}

export type StepPatch = { state: StepState; detail?: string | null };

export type ImportOutcome = 'pending' | 'moved' | 'converted' | 'review' | 'unchanged' | 'failed' | 'not processed';

/** One file of an automatic import, as shown in the Activity panel and CLI. */
export interface ImportRow {
  rel: string;
  kind: ParsedKind;
  status: ItemStatus;
  newRel: string | null;
  target: string | null;
  match: string | null;
  message: string | null;
  audio: string | null;
  outcome: ImportOutcome;
}

export interface ImportResult {
  imported: number;
  converted: number;
  review: number;
  failed: number;
  cancelled: boolean;
  targets: string[];
  dryRun?: boolean;
  planned?: number;
  toConvert?: number;
}

export type JobResult = ApplyResult | UndoResult | ImportResult;

/** What a running job gets to report progress and react to cancelling. */
export interface JobControl {
  /** Aborts immediately; the current copy or conversion is discarded. */
  signal: AbortSignal;
  /** Asks the job to stop after the current file. */
  stopSignal?: AbortSignal;
  onProgress?: ProgressListener;
  defineSteps: (steps: StepDefinition[]) => void;
  step: (id: string, patch: StepPatch) => void;
  setFiles: (files: ImportRow[]) => void;
}

export type JobRunner = (control: JobControl) => Promise<JobResult>;

/** A job as clients see it (see JobManager.snapshot). */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  root: string;
  targets: string[];
  params: { path?: string; requested?: string };
  label: string | null;
  source: string;
  state: JobState;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  note: string | null;
  steps: Step[];
  files: ImportRow[];
  progress: Progress;
  result: JobResult | null;
  error: string | null;
  queuePosition?: number;
  fileCount?: number;
}
