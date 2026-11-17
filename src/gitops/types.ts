// Types shared by the config-as-code modules (extension host) and the Plan webview.
// No imports: the webview bundles this file.

export type ResourceKind = "stream" | "consumer" | "kv";

/** Terraform-style plan actions. Markers: + create, ~ update, = unchanged, ! drift, × error. */
export type PlanAction = "create" | "update" | "unchanged" | "drift" | "error";

export const PLAN_ACTIONS: readonly PlanAction[] = ["create", "update", "unchanged", "drift", "error"];

export const ACTION_MARKER: Record<PlanAction, string> = {
  create: "+",
  update: "~",
  unchanged: "=",
  drift: "!",
  error: "×",
};

export const KIND_LABEL: Record<ResourceKind, string> = {
  stream: "stream",
  consumer: "consumer",
  kv: "kv bucket",
};

/** How to render a config value: nanosecond / millisecond durations, byte sizes, plain counts. */
export type ValueUnit = "ns" | "ms" | "bytes" | "count";

/** One key-level difference between the local file and the server. */
export interface ConfigChange {
  /** Dotted path, e.g. `max_age`, `metadata.owner`, `sources[0].filter_subject`. */
  path: string;
  /** add = the server has no value for this key yet; change = the value differs. */
  op: "add" | "change";
  from?: unknown;
  to: unknown;
  unit?: ValueUnit;
  /** Set when the server rejects this change on an existing resource (why, and what to do instead). */
  immutable?: string;
  /** Side effect worth a second look (message loss, irreversible settings). */
  risk?: string;
}

export interface PlanItem {
  /** `stream:ORDERS`, `consumer:ORDERS/billing`, `kv:config` (or `file:<path>` for unreadable files). */
  id: string;
  kind?: ResourceKind;
  name: string;
  /** Parent stream for consumers. */
  stream?: string;
  action: PlanAction;
  /** Config file path relative to the planned folder. */
  file?: string;
  /** update: key-level changes. */
  changes: ConfigChange[];
  /** create: the local fields; drift: the server's fields (for display). */
  fields?: ConfigChange[];
  error?: string;
  /** Present when the item cannot be applied as-is (immutable changes); the text says why. */
  blocked?: string;
  warnings: string[];
  /** Another item that must be applied first (consumer on a stream that is being created). */
  dependsOn?: string;
  /** The plan used unsaved editor content for this file. */
  unsaved?: boolean;
}

export type Environment = "dev" | "test" | "staging" | "prod";

export interface PlanConnection {
  id: string;
  name: string;
  env?: Environment;
  readOnly?: boolean;
  /** Server name / version, when connected. */
  server?: string;
  url?: string;
  state: "connected" | "connecting" | "reconnecting" | "disconnected" | "error";
}

export interface PlanResult {
  /** Absolute folder path. */
  folder: string;
  /** Workspace-relative label. */
  folderLabel: string;
  connection: PlanConnection;
  generatedAt: number;
  durationMs: number;
  /** Config files read (the folder's own files; subfolders are planned separately). */
  files: number;
  /** Subfolders (relative) that contain config files of their own. */
  subfolders?: string[];
  /** Resource kinds present in the folder: drift is only reported for these. */
  scope: ResourceKind[];
  items: PlanItem[];
  counts: Record<PlanAction, number>;
  jetstream: boolean;
}

export type ApplyState = "pending" | "running" | "done" | "failed" | "skipped";

export interface ApplyProgress {
  id: string;
  state: ApplyState;
  /** done: created / updated / unchanged; failed / skipped: the reason. */
  message?: string;
}

export interface ApplySummary {
  cancelled?: boolean;
  applied: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: ApplyProgress[];
}

export interface PlanInit {
  folder: string;
  folderLabel: string;
  connection?: PlanConnection;
}
