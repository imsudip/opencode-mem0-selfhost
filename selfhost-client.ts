/**
 * Self-host Mem0 REST client.
 *
 * Thin wrapper over `fetch` that exposes the same surface the upstream
 * `MemoryClient` from the `mem0ai` SDK does, so `opencode-mem0.ts` can use
 * the plugin code unchanged for tool/hook wiring — only the call site
 * differs.
 *
 * The self-host server's REST surface (see https://docs.mem0.ai/open-source/setup):
 *   POST   /memories              add (messages, user_id, metadata, infer)
 *   POST   /search                search (query, filters, top_k)
 *   GET    /memories              list (user_id, agent_id, run_id, top_k as query params)
 *   GET    /memories/{id}         get one
 *   PUT    /memories/{id}         update (text, metadata)
 *   DELETE /memories/{id}         delete one
 *   GET    /health                liveness (used by health check)
 *
 * Differences from the `mem0ai` Platform SDK that callers need to know about:
 *
 *   1. **No first-class `app_id`.** The self-host REST only supports
 *      `user_id`, `agent_id`, `run_id`, and `metadata` as top-level identity
 *      fields. We put `app_id` under `metadata.app_id` on writes, and filter
 *      by it client-side on reads (`getAll`).
 *
 *   2. **Synchronous writes.** The Platform returns `{event_id, ...}` and
 *      writes happen async; the self-host server returns the written memory
 *      directly. No `getEventStatus` polling needed.
 *
 *   3. **No admin bulk-delete by identity.** `deleteAll` therefore has to
 *      fetch the matching IDs first, then delete one by one. This is safe but
 *      slow for projects with thousands of memories.
 *
 *   4. **No entity management.** `deleteUsers` / `users` are stubs that
 *      return `{unsupported: true}`.
 */

export interface SelfHostMemoryClientOptions {
  apiKey?: string;
  /** Base URL of the self-host server, e.g. `http://localhost:8888`. */
  host?: string;
  /** Default `user_id` for calls that don't pass one explicitly. */
  defaultUserId?: string;
  /** Default `app_id`; written to `metadata.app_id` on every `add`. */
  defaultAppId?: string;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export interface AddMessage {
  role: string;
  content: string;
}

export interface Memory {
  id: string;
  memory: string;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface SearchFilters {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  app_id?: string;
  [key: string]: unknown;
}

export interface AddOptions {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  app_id?: string;
  metadata?: Record<string, unknown>;
  infer?: boolean;
}

export interface SearchOptions {
  filters?: SearchFilters;
  top_k?: number;
  threshold?: number;
}

export interface GetAllOptions {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  app_id?: string;
  filters?: SearchFilters;
  page?: number;
  page_size?: number;
}

export interface GetAllResult {
  results: Memory[];
  count: number;
}

export interface UpdateOptions {
  text?: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_HOST = "http://localhost:8888";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Strip trailing slashes and any trailing `/api` or `/v0` suffix. */
function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "").replace(/\/(api|v\d+)$/, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a shallow copy with `undefined` and `null` values removed. */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * The self-host REST supports `user_id` / `agent_id` / `run_id` as flat query
 * params on `GET /memories`, but not `app_id` (which lives in metadata) and not
 * arbitrary AND/OR filter syntax. We pull what we can out of an arbitrary
 * filter object and pass the rest to client-side filtering.
 */
function extractFlatIds(filters: SearchFilters | undefined): {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
} {
  if (!filters) return {};
  return compact({
    user_id: typeof filters.user_id === "string" ? filters.user_id : undefined,
    agent_id: typeof filters.agent_id === "string" ? filters.agent_id : undefined,
    run_id: typeof filters.run_id === "string" ? filters.run_id : undefined,
  });
}

function memoryMatches(memory: Memory, filters: SearchFilters | undefined): boolean {
  if (!filters) return true;
  for (const [key, expected] of Object.entries(filters)) {
    if (key === "AND" || key === "OR" || key === "NOT") continue; // unsupported
    const actual =
      key === "user_id" || key === "agent_id" || key === "run_id"
        ? (memory[key] ?? memory.metadata?.[key])
        : key === "app_id"
          ? (memory.metadata?.app_id)
          : (memory.metadata as Record<string, unknown> | undefined)?.[key];
    if (typeof expected === "object" && expected !== null) {
      // Operators: eq / ne / in / contains etc. (mirrors selfhost-client filter shape)
      if ("eq" in expected && actual !== expected.eq) return false;
      if ("ne" in expected && actual === expected.ne) return false;
      if ("in" in expected && Array.isArray(expected.in) && !expected.in.includes(actual as never)) return false;
      if ("contains" in expected && !String(actual ?? "").includes(String(expected.contains))) return false;
      continue;
    }
    if (expected === "*") continue;
    if (actual !== expected) return false;
  }
  return true;
}

function extractMemories(response: unknown): Memory[] {
  if (Array.isArray(response)) return response as Memory[];
  if (isPlainObject(response) && Array.isArray(response.results)) {
    return response.results as Memory[];
  }
  return [];
}

export class SelfHostMemoryClient {
  private readonly apiKey: string | undefined;
  private readonly host: string;
  private readonly defaultUserId: string | undefined;
  private readonly defaultAppId: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: SelfHostMemoryClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.MEM0_API_KEY;
    this.host = normalizeHost(
      options.host ??
        process.env.MEM0_HOST ??
        process.env.MEM0_SELF_HOST_URL ??
        DEFAULT_HOST,
    );
    this.defaultUserId = options.defaultUserId;
    this.defaultAppId = options.defaultAppId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Test-only — exposed so the build hook can construct a custom client. */
  get config(): { host: string; hasApiKey: boolean } {
    return { host: this.host, hasApiKey: Boolean(this.apiKey) };
  }

  async add(messages: AddMessage[], options: AddOptions = {}): Promise<Memory[]> {
    const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
    const appId = options.app_id ?? this.defaultAppId;
    if (appId !== undefined && metadata.app_id === undefined) {
      metadata.app_id = appId;
    }

    const body = compact({
      messages,
      user_id: options.user_id ?? this.defaultUserId,
      agent_id: options.agent_id,
      run_id: options.run_id,
      metadata,
      infer: options.infer,
    });

    const response = await this.request<unknown>("POST", "/memories", { body });
    // Self-host returns either a Memory, a list of Memories, or {results: [...]}.
    const results = extractMemories(response);
    if (results.length > 0) return results;
    if (isPlainObject(response) && typeof response.id === "string") {
      return [response as unknown as Memory];
    }
    return [];
  }

  async search(query: string, options: SearchOptions = {}): Promise<Memory[]> {
    const body = compact({
      query,
      filters: options.filters,
      top_k: options.top_k,
      threshold: options.threshold,
    });
    const response = await this.request<unknown>("POST", "/search", { body });
    return extractMemories(response);
  }

  /**
   * List memories. The self-host server only filters by `user_id`/`agent_id`/
   * `run_id` at the API level — `app_id` and any other filter key must be
   * applied client-side from `metadata`.
   */
  async getAll(options: GetAllOptions = {}): Promise<GetAllResult> {
    const filters: SearchFilters = { ...(options.filters ?? {}) };
    if (options.user_id !== undefined) filters.user_id = options.user_id;
    if (options.agent_id !== undefined) filters.agent_id = options.agent_id;
    if (options.run_id !== undefined) filters.run_id = options.run_id;
    if (options.app_id !== undefined) filters.app_id = options.app_id;

    const pageSize = options.page_size ?? 20;
    const page = options.page ?? 1;
    // Fetch a chunk large enough to cover the requested page; client-side
    // filtering then slices it.
    const fetchLimit = Math.max(page * pageSize, pageSize);

    const flat = extractFlatIds(filters);
    const query = compact({
      ...flat,
      top_k: fetchLimit,
    });

    const response = await this.request<unknown>("GET", "/memories", { query });
    const filtered = extractMemories(response).filter((m) => memoryMatches(m, filters));
    const start = (Math.max(page, 1) - 1) * pageSize;
    return {
      results: filtered.slice(start, start + pageSize),
      count: filtered.length,
    };
  }

  async get(id: string): Promise<Memory> {
    return this.request<Memory>("GET", `/memories/${encodeURIComponent(id)}`);
  }

  async update(id: string, options: UpdateOptions): Promise<Memory> {
    const body = compact({
      text: options.text,
      metadata: options.metadata,
    });
    return this.request<Memory>("PUT", `/memories/${encodeURIComponent(id)}`, { body });
  }

  async delete(id: string): Promise<{ id: string; deleted: true }> {
    await this.request<unknown>("DELETE", `/memories/${encodeURIComponent(id)}`);
    return { id, deleted: true };
  }

  /**
   * The self-host server's admin bulk-delete endpoint ignores metadata filters
   * (notably `app_id`), which would be unsafe to call with a first-class
   * `user_id` (it would wipe the user's memories across every project).
   * Instead: list matching memories, then delete them one at a time.
   */
  async deleteAll(options: GetAllOptions = {}): Promise<{ deleted: number }> {
    const pageSize = 200;
    let page = 1;
    let totalDeleted = 0;
    // Up to 50 pages of 200 = 10k memories. Caps accidental wide wipes; tune
    // if you legitimately have more memories to clear in one go.
    const MAX_PAGES = 50;
    while (page <= MAX_PAGES) {
      const { results } = await this.getAll({ ...options, page, page_size: pageSize });
      if (results.length === 0) break;
      for (const m of results) {
        if (typeof m.id === "string") {
          await this.delete(m.id);
          totalDeleted++;
        }
      }
      if (results.length < pageSize) break;
      page++;
    }
    return { deleted: totalDeleted };
  }

  /** Self-host doesn't expose entity management. Stub for compatibility. */
  async deleteUsers(_options: Record<string, unknown> = {}): Promise<{ unsupported: true; message: string }> {
    return {
      unsupported: true,
      message: "Self-host Mem0 REST does not expose entity deletion; delete matching memories instead.",
    };
  }

  /** Self-host doesn't expose entity management. Stub for compatibility. */
  async users(_options: Record<string, unknown> = {}): Promise<{ unsupported: true; message: string }> {
    return {
      unsupported: true,
      message: "Self-host Mem0 REST does not expose entity listing.",
    };
  }

  /**
   * Health check. Pings `GET /health` (or `/` if the server doesn't expose
   * `/health`) and returns whether the server responded with a 2xx status.
   * Use this in your deployment / monitoring, not from inside the plugin.
   */
  async health(): Promise<{ ok: boolean; status: number; host: string }> {
    const paths = ["/health", "/"];
    let lastStatus = 0;
    for (const path of paths) {
      try {
        const res = await fetch(new URL(path, `${this.host}/`), {
          method: "GET",
          headers: this.apiKey ? { "X-API-Key": this.apiKey } : {},
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        lastStatus = res.status;
        if (res.ok) return { ok: true, status: res.status, host: this.host };
      } catch {
        /* try next path */
      }
    }
    return { ok: false, status: lastStatus, host: this.host };
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Record<string, unknown>; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ""), `${this.host}/`);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    if (options.body) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`mem0 self-host ${method} ${url.pathname} failed: ${msg} (host=${this.host})`);
    }

    const text = await res.text();
    const parsed: unknown = text ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const detail =
        isPlainObject(parsed) && (typeof parsed.detail === "string" || typeof parsed.message === "string")
          ? (parsed.detail as string) ?? (parsed.message as string)
          : text || res.statusText;
      throw new Error(`mem0 self-host ${method} ${url.pathname} failed (${res.status}): ${detail} (host=${this.host})`);
    }

    return parsed as T;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
