# opencode-mem0-selfhost

Persistent memory for [OpenCode](https://opencode.ai), backed by a **self-hosted**
[Mem0](https://docs.mem0.ai/open-source/setup) REST server. Your agent remembers
decisions, preferences, and learnings across sessions — without sending data to
any third-party cloud.

This is a self-host fork of the official
[`@mem0/opencode-plugin`](https://github.com/mem0ai/mem0/tree/main/integrations/mem0-plugin/.opencode-plugin).
The hooks, tool names, slash skills, scope model, and memory context injection
are all preserved; only the SDK call layer is swapped for a small REST client
that talks to your self-host server.

## Install

```bash
git clone https://github.com/imsudip/opencode-mem0-selfhost.git
cd opencode-mem0-selfhost
bun install
bun run build
```

Then add the built plugin to `~/.config/opencode/opencode.json` (or a
project-level `opencode.json`):

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-mem0-selfhost/dist/index.js"
  ]
}
```

## Configure

Point the plugin at your self-host Mem0 REST server. Defaults to
`http://localhost:8888`.

```bash
# Required — the X-API-Key value your self-host server accepts
export MEM0_API_KEY="m0sk_your-key"

# Optional — base URL of your self-host Mem0 server
export MEM0_HOST="http://localhost:8888"

# Optional — stable user identity (defaults to $USER / os.userInfo().username)
export MEM0_USER_ID="your-name"

# Optional — override the auto-detected git-remote-based project id
export MEM0_APP_ID="my-project"
```

If `MEM0_HOST` is not set, the client falls back to
`http://localhost:8888` (the port the reference self-host Docker stack binds).

## What's included

| Component | Description |
|-----------|-------------|
| **9 Native Memory Tools** | `add_memory`, `search_memories`, `get_memories`, `get_memory`, `update_memory`, `delete_memory`, `delete_all_memories`, `delete_entities`, `list_entities`, plus a `get_event_status` compatibility stub (self-host writes are synchronous, so it returns `UNSUPPORTED`) |
| **Lifecycle Hooks** | Auto-search on session start, per-prompt search, error memory lookup, compaction context injection, secret redaction, MEMORY.md write blocking |
| **9 Skills** | `/mem0-remember`, `/mem0-tour`, `/mem0-search`, `/mem0-status`, `/mem0-scope`, `/mem0-dream`, `/mem0-forget`, `/mem0-pin`, `/mem0-context-loader` — discovered in place from `opencode-skills/` |
| **Auto-dream** | Gated memory consolidation (time + sessions + memory-count). Opt-out via `MEM0_DREAM=false` or the `dream` block in `~/.mem0/settings.json` |

## Self-host differences from the official plugin

- **No `mem0ai` SDK dependency.** All memory operations are plain `fetch` calls
  against your self-host server.
- **No phone-home telemetry.** Telemetry is **opt-in** (`MEM0_TELEMETRY=true`),
  unlike upstream where it's opt-out. Disabled by default.
- **No `mem0ai` Cloud project APIs.** Project category auto-setup and async
  event status are no-ops — the self-host REST API doesn't expose them.
- **`app_id` is stored in metadata.** The self-host REST API only supports
  `user_id`, `agent_id`, `run_id`, and `metadata` as top-level identity
  fields. The plugin transparently places `app_id` under `metadata.app_id` on
  every write and filters by it client-side on reads.
- **`delete_all_memories` is a list-then-delete loop** rather than a single
  bulk call. The self-host admin bulk-delete endpoint ignores metadata filters,
  so the plugin fetches the matching IDs first and deletes them one at a time.

## Verify

Start OpenCode and ask: *"Search my memories for recent decisions"*

If the `mem0_*` tools respond and the dashboard at your `MEM0_HOST` shows the
new write, you're all set.

You can also run `/mem0-status` to see a diagnostic summary.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No tools appearing | Restart OpenCode after installing |
| `Connection refused` | Check `MEM0_HOST`; default is `http://localhost:8888` |
| `401 Unauthorized` | `echo $MEM0_API_KEY` — the value must match the API key your self-host server accepts |
| Plugin not loading | Verify the `file://` path in `opencode.json` points to `dist/index.js` and that `bun run build` ran without errors |
| Memories missing project context | `app_id` is stored in metadata, not as a top-level field. Searches that use `metadata.app_id` will find them; searches that use top-level `app_id` will not. |
| `get_event_status` returns `UNSUPPORTED` | Expected. Self-host writes are synchronous — the response from `add_memory` already contains the memory ID. |

## Upstream sync

The `.github/workflows/sync-upstream.yml` workflow runs weekly (and on demand)
and opens a PR when `mem0ai/mem0`'s `integrations/mem0-plugin/.opencode-plugin/`
directory changes. The PR bumps the `.upstream-sha` ref and includes the upstream
diff in its body. The diff is informational — porting upstream changes into our
source files is a manual step (because upstream uses `mem0ai` SDK calls that we
replace with REST).

## Development

```bash
bun install
bun run type-check   # tsc --noEmit
bun run test         # bun test
bun run build        # bun build + tsc emit-decls → dist/
```

The build produces `dist/index.js` (the bundled plugin) and `dist/index.d.ts`
(types). Both are referenced from `package.json#exports`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
