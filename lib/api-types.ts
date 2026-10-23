// The HTTP API between the web UI and the server: what each POST /api/… route
// takes and returns. Type-only module, imported by the server routes and by web/.
import type {
  Filters,
  JobSnapshot,
  ParsedMedia,
  Patterns,
  PreviewItem,
  RenameRequest,
  SavedSettings,
  Settings,
  Targets,
} from './types.ts';

/* ---------- Folders ---------- */

export interface FolderEntry {
  name: string;
  path: string;
}

export type PlaceKind = 'home' | 'folder' | 'drive' | 'volume';

export interface Place {
  label: string;
  path: string;
  kind: PlaceKind;
}

export interface Breadcrumb {
  label: string;
  path: string;
}

/** One folder as shown by the built-in folder browser. */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  separator: string;
  breadcrumbs: Breadcrumb[];
  folders: FolderEntry[];
  truncated: boolean;
  mediaFiles: number;
}

export interface PlacesResponse {
  platform: string;
  separator: string;
  places: Place[];
  nativeDialog: boolean;
  tmdbConfigured: boolean;
}

export type PickFolderResult = { path: string; cancelled?: undefined } | { cancelled: true; path?: undefined };

/* ---------- Settings ---------- */

export interface SettingsResponse {
  /** Effective settings: saved values over the server's defaults. */
  settings: Settings;
  /** The server's defaults (environment and built-ins). */
  defaults: Settings;
  saved: boolean;
  savedAt: string | null;
  problems: string[];
}

/** GET-style settings read: also reports what the server can do. */
export interface SettingsInfoResponse extends SettingsResponse {
  tmdbConfigured: boolean;
  hookEnabled: boolean;
  audioToolsAvailable: boolean;
}

/* ---------- Scan and preview ---------- */

export interface ScanRequest extends Partial<Filters> {
  root: string;
  recursive?: boolean;
}

export interface ScanResponse {
  root: string;
  truncated: boolean;
  excluded: { samples: number; nonVideo: number };
  filters: Filters;
  files: { rel: string; parsed: ParsedMedia }[];
}

export interface PreviewRequest extends Partial<Filters> {
  root: string;
  files: string[];
  targets?: Partial<Targets>;
  patterns?: Partial<Patterns>;
  language?: string;
  region?: string | null;
}

export interface PreviewResponse {
  root: string;
  targets: Targets;
  language: string;
  region: string | null;
  patterns: Patterns;
  items: PreviewItem[];
}

/* ---------- Jobs ---------- */

export interface ApplyRequest {
  root: string;
  renames: Pick<RenameRequest, 'from' | 'to' | 'target' | 'overwrite'>[];
  /** Files (relative to root) to delete, e.g. a download already in the library. Not undoable. */
  remove?: string[];
}

/** The next free name for keeping a file next to one that already has its name. */
export interface FreeNameRequest {
  root: string;
  /** The destination folder, or null when renamed in place. */
  target: string | null;
  /** The wanted name, relative to the destination. */
  rel: string;
  /** Names already planned for the same destination. */
  taken?: string[];
}

/** The job's id identifies it in later /api/job and /api/job/cancel calls. */
export type StartedJob = JobSnapshot & { duplicate?: boolean };

/** All routes, as path → [request body, response body]. */
export interface ApiRoutes {
  '/api/places': [Record<string, never>, PlacesResponse];
  '/api/settings': [Record<string, never>, SettingsInfoResponse];
  '/api/settings/save': [{ settings: SavedSettings }, SettingsResponse];
  '/api/settings/reset': [Record<string, never>, SettingsResponse];
  '/api/browse': [{ path: string; showHidden?: boolean }, DirectoryListing];
  '/api/pick-folder': [{ start?: string }, PickFolderResult];
  '/api/scan': [ScanRequest, ScanResponse];
  '/api/preview': [PreviewRequest, PreviewResponse];
  '/api/free-name': [FreeNameRequest, { newRel: string }];
  '/api/apply': [ApplyRequest, StartedJob];
  '/api/undo': [{ root: string }, StartedJob];
  '/api/job': [{ id?: string }, { job: JobSnapshot | null }];
  '/api/jobs': [Record<string, never>, { jobs: JobSnapshot[] }];
  '/api/job/cancel': [{ id: string }, { job: JobSnapshot }];
  '/api/jobs/clear': [Record<string, never>, { removed: number }];
  '/api/push/key': [Record<string, never>, { publicKey: string }];
  '/api/push/subscribe': [{ subscription: unknown }, { ok: true }];
  '/api/push/unsubscribe': [{ endpoint: string }, { ok: true }];
}

export type ApiPath = keyof ApiRoutes;
export type ApiRequest<P extends ApiPath> = ApiRoutes[P][0];
export type ApiResponse<P extends ApiPath> = ApiRoutes[P][1];
