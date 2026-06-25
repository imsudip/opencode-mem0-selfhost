/**
 * Plugin telemetry for opencode-mem0-selfhost — anonymous usage tracking
 * via PostHog.
 *
 * **Opt-in.** Disabled by default. The upstream `@mem0/opencode-plugin` ships
 * with telemetry enabled; this fork flips the default because self-host users
 * tend to be more privacy-sensitive and the whole point of self-hosting is to
 * keep data local. Enable with `MEM0_TELEMETRY=true`.
 *
 * When enabled, emits the SAME event schema as the Mem0 editor plugin
 * (`plugin.*` events, `source: "plugin"`, `platform: "opencode"`,
 * `distinct_id = sha256(apiKey)[:32]`) so OpenCode shows up as just another
 * `platform` value in the shared plugin dashboard.
 *
 * Fire-and-forget: never throws, never blocks, failures are swallowed. Only
 * fires when an API key is present (anonymous installs without a key emit
 * nothing).
 *
 * Never sends: memory content, API keys, raw user/project IDs. Only sends:
 * event type, platform, plugin version, and anonymized hashes of the API key
 * and project ID.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { release } from "node:os";

const POSTHOG_API_KEY = "phc_hgJkUVJFYtmaJqrvf6CYN67TIQ8yhXAkWzUn9AMU4yX";
const POSTHOG_HOST = "https://us.i.posthog.com/i/v0/e/";
const REQUEST_TIMEOUT_MS = 2_000;

function _loadPluginVersion(): string {
  // Source context: telemetry.ts sits next to package.json (./).
  // Bundled context: dist/index.js sits one level below it (../).
  for (const rel of ["./package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8"));
      if (pkg?.name === "opencode-mem0-selfhost" && pkg.version) return pkg.version;
    } catch {
      /* try next candidate */
    }
  }
  return "unknown";
}

const PLUGIN_VERSION = _loadPluginVersion();

/**
 * Telemetry is opt-in. Unlike upstream, we do NOT default to enabled —
 * set MEM0_TELEMETRY=true to enable. This matches the self-host privacy
 * expectation.
 */
export function isTelemetryEnabled(): boolean {
  const val = process.env.MEM0_TELEMETRY;
  if (val === undefined) return false;
  const s = val.toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function distinctId(apiKey: string): string {
  // Matches the editor plugin's _distinct_id() so the same user is one person
  // in PostHog whether they use OpenCode or any other Mem0 plugin.
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
}

/**
 * Build the PostHog event payload, or null when telemetry is disabled or no
 * API key is available. Pure (aside from env/version reads) and exported for
 * testing. System-controlled properties are applied last so a caller cannot
 * override `source`/`platform`/etc.
 */
export function buildEvent(
  eventType: string,
  properties: Record<string, unknown>,
  apiKey: string | undefined,
  projectId?: string,
): Record<string, unknown> | null {
  if (!isTelemetryEnabled() || !apiKey) return null;
  return {
    api_key: POSTHOG_API_KEY,
    distinct_id: distinctId(apiKey),
    event: `plugin.${eventType}`,
    properties: {
      ...properties,
      source: "plugin",
      platform: "opencode",
      plugin_version: PLUGIN_VERSION,
      os: process.platform,
      os_version: release(),
      sample_rate: 1.0,
      $process_person_profile: false,
      $lib: "posthog-node",
      ...(projectId
        ? { project_hash: createHash("sha256").update(projectId).digest("hex") }
        : {}),
    },
  };
}

/** Send a usage event, fire-and-forget. Never throws, never blocks. */
export function captureEvent(
  eventType: string,
  properties: Record<string, unknown>,
  apiKey: string | undefined,
  projectId?: string,
): void {
  const payload = buildEvent(eventType, properties, apiKey, projectId);
  if (!payload) return;
  try {
    void fetch(POSTHOG_HOST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
      /* fire-and-forget */
    });
  } catch {
    /* never throw */
  }
}
