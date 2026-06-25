import { afterEach, beforeEach, describe, expect, test, mock, spyOn } from "bun:test";
import { SelfHostMemoryClient } from "./selfhost-client";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.MEM0_HOST;
  delete process.env.MEM0_SELF_HOST_URL;
  delete process.env.MEM0_API_KEY;
});

function mockFetchOnce(status: number, body: unknown, contentType = "application/json") {
  globalThis.fetch = mock(async () => {
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status, headers: { "Content-Type": contentType } },
    );
  }) as typeof fetch;
}

function lastCall(): { url: string; init: RequestInit | undefined } {
  const spy = globalThis.fetch as unknown as ReturnType<typeof mock>;
  const calls = spy.mock.calls as Array<[string, RequestInit?]>;
  const last = calls[calls.length - 1];
  return { url: last[0], init: last[1] };
}

describe("SelfHostMemoryClient — host resolution", () => {
  test("uses MEM0_HOST when set", () => {
    process.env.MEM0_HOST = "http://my-mem0:8888";
    const c = new SelfHostMemoryClient({ apiKey: "k" });
    expect(c.config.host).toBe("http://my-mem0:8888");
  });

  test("falls back to MEM0_SELF_HOST_URL when MEM0_HOST is unset", () => {
    process.env.MEM0_SELF_HOST_URL = "http://legacy:9999/";
    const c = new SelfHostMemoryClient({ apiKey: "k" });
    expect(c.config.host).toBe("http://legacy:9999");
  });

  test("defaults to http://localhost:8888 when nothing is set", () => {
    const c = new SelfHostMemoryClient({ apiKey: "k" });
    expect(c.config.host).toBe("http://localhost:8888");
  });

  test("strips trailing slashes and /api or /v0 suffixes", () => {
    expect(new SelfHostMemoryClient({ host: "http://x:8888///", apiKey: "k" }).config.host).toBe("http://x:8888");
    expect(new SelfHostMemoryClient({ host: "http://x:8888/api", apiKey: "k" }).config.host).toBe("http://x:8888");
    expect(new SelfHostMemoryClient({ host: "http://x:8888/v0/", apiKey: "k" }).config.host).toBe("http://x:8888");
  });
});

describe("SelfHostMemoryClient — auth", () => {
  test("sends X-API-Key header when apiKey is set", async () => {
    mockFetchOnce(200, { id: "m1", memory: "hi" });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "secret-key" });
    await c.get("m1");
    const { init } = lastCall();
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("secret-key");
  });

  test("omits X-API-Key header when no apiKey", async () => {
    mockFetchOnce(200, { id: "m1" });
    const c = new SelfHostMemoryClient({ host: "http://h:1" });
    await c.get("m1");
    const { init } = lastCall();
    const headers = init?.headers as Record<string, string>;
    expect("X-API-Key" in headers).toBe(false);
  });
});

describe("SelfHostMemoryClient — add()", () => {
  test("moves top-level app_id into metadata.app_id", async () => {
    mockFetchOnce(200, [{ id: "m1", memory: "hello", metadata: { app_id: "my-proj" } }]);
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await c.add([{ role: "user", content: "hello" }], {
      user_id: "u1",
      app_id: "my-proj",
    });
    const { init } = lastCall();
    const body = JSON.parse(init?.body as string);
    expect(body.metadata.app_id).toBe("my-proj");
    expect("app_id" in body).toBe(false);
  });

  test("uses defaultAppId when no app_id is provided", async () => {
    mockFetchOnce(200, []);
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k", defaultAppId: "default-proj" });
    await c.add([{ role: "user", content: "x" }], { user_id: "u1" });
    const { init } = lastCall();
    const body = JSON.parse(init?.body as string);
    expect(body.metadata.app_id).toBe("default-proj");
  });

  test("preserves caller-supplied metadata.app_id (does not overwrite)", async () => {
    mockFetchOnce(200, []);
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k", defaultAppId: "default" });
    await c.add([{ role: "user", content: "x" }], {
      user_id: "u1",
      app_id: "from-arg",
      metadata: { app_id: "from-metadata", custom: 1 },
    });
    const { init } = lastCall();
    const body = JSON.parse(init?.body as string);
    expect(body.metadata.app_id).toBe("from-metadata");
    expect(body.metadata.custom).toBe(1);
  });

  test("returns the memory array from a list response", async () => {
    mockFetchOnce(200, [{ id: "m1", memory: "x" }, { id: "m2", memory: "y" }]);
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    const res = await c.add([{ role: "user", content: "x" }], { user_id: "u" });
    expect(res).toHaveLength(2);
    expect(res[0]?.id).toBe("m1");
  });

  test("returns a single memory from an object response", async () => {
    mockFetchOnce(200, { id: "m1", memory: "x" });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    const res = await c.add([{ role: "user", content: "x" }], { user_id: "u" });
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe("m1");
  });
});

describe("SelfHostMemoryClient — getAll() client-side filtering", () => {
  test("passes user_id / agent_id / run_id as query params", async () => {
    mockFetchOnce(200, { results: [] });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await c.getAll({ user_id: "u1", agent_id: "a1", run_id: "r1" });
    const { url } = lastCall();
    const parsed = new URL(url);
    expect(parsed.searchParams.get("user_id")).toBe("u1");
    expect(parsed.searchParams.get("agent_id")).toBe("a1");
    expect(parsed.searchParams.get("run_id")).toBe("r1");
  });

  test("does NOT pass app_id as a query param (server doesn't support it)", async () => {
    mockFetchOnce(200, { results: [] });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await c.getAll({ user_id: "u1", app_id: "my-proj" });
    const { url } = lastCall();
    const parsed = new URL(url);
    expect(parsed.searchParams.has("app_id")).toBe(false);
  });

  test("filters results by metadata.app_id client-side", async () => {
    mockFetchOnce(200, {
      results: [
        { id: "m1", memory: "a", user_id: "u1", metadata: { app_id: "proj-a" } },
        { id: "m2", memory: "b", user_id: "u1", metadata: { app_id: "proj-b" } },
        { id: "m3", memory: "c", user_id: "u1", metadata: { app_id: "proj-a" } },
      ],
    });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    const res = await c.getAll({ user_id: "u1", app_id: "proj-a" });
    expect(res.count).toBe(2);
    expect(res.results.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  test("respects page + page_size when slicing filtered results", async () => {
    mockFetchOnce(200, {
      results: Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        memory: `m${i}`,
        user_id: "u",
        metadata: { app_id: "p" },
      })),
    });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    const page1 = await c.getAll({ user_id: "u", app_id: "p", page: 1, page_size: 2 });
    expect(page1.count).toBe(5);
    expect(page1.results.map((m) => m.id)).toEqual(["m0", "m1"]);

    const page2 = await c.getAll({ user_id: "u", app_id: "p", page: 2, page_size: 2 });
    expect(page2.results.map((m) => m.id)).toEqual(["m2", "m3"]);
  });
});

describe("SelfHostMemoryClient — error handling", () => {
  test("error message includes the host and path", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ detail: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const c = new SelfHostMemoryClient({ host: "http://my-host:1234", apiKey: "k" });
    try {
      await c.get("any");
      expect(true).toBe(false); // shouldn't reach
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("http://my-host:1234");
      expect(msg).toContain("401");
      expect(msg).toContain("unauthorized");
    }
  });

  test("error message handles non-JSON error bodies", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("plain text error", { status: 500 });
    }) as typeof fetch;
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    try {
      await c.get("any");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("500");
      expect((err as Error).message).toContain("plain text error");
    }
  });
});

describe("SelfHostMemoryClient — users() (entity listing)", () => {
  test("calls GET /entities", async () => {
    mockFetchOnce(200, [
      { id: "alice", type: "user", total_memories: 12 },
      { id: "bot-1", type: "agent", total_memories: 3 },
    ]);
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    const res = await c.users({});
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(2);
    expect(res[0]?.id).toBe("alice");
    expect(res[0]?.type).toBe("user");
    const { url } = lastCall();
    expect(new URL(url).pathname).toBe("/entities");
  });

  test("ignores page/page_size (single list, server doesn't paginate)", async () => {
    mockFetchOnce(200, []);
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await c.users({ page: 99, page_size: 50 });
    const { url } = lastCall();
    expect(new URL(url).search).toBe("");
  });
});

describe("SelfHostMemoryClient — deleteUsers() (entity deletion)", () => {
  test("DELETE /entities/user/{id} when only user_id is given", async () => {
    mockFetchOnce(200, { message: "Entity deleted" });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    const r = await c.deleteUsers({ user_id: "alice" });
    expect(r.message).toBe("Entity deleted");
    const { url } = lastCall();
    expect(new URL(url).pathname).toBe("/entities/user/alice");
  });

  test("DELETE /entities/agent/{id} when agent_id is given", async () => {
    mockFetchOnce(200, { message: "Entity deleted" });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await c.deleteUsers({ agent_id: "bot-1" });
    const { url } = lastCall();
    expect(new URL(url).pathname).toBe("/entities/agent/bot-1");
  });

  test("DELETE /entities/run/{id} when run_id is given", async () => {
    mockFetchOnce(200, { message: "Entity deleted" });
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await c.deleteUsers({ run_id: "ses_123" });
    const { url } = lastCall();
    expect(new URL(url).pathname).toBe("/entities/run/ses_123");
  });

  test("throws when no entity id is provided", async () => {
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await expect(c.deleteUsers({})).rejects.toThrow(/one of user_id, agent_id, or run_id is required/);
  });
});

describe("SelfHostMemoryClient — update() requires text", () => {
  test("reads current memory and sends its text when text is not provided", async () => {
    // First call: GET /memories/{id} returns the current memory.
    // Second call: PUT /memories/{id} with the text.
    const fetchMock = mock(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        // Echo back so we can assert.
        return new Response(JSON.stringify({ id: "m1", memory: body.text, metadata: body.metadata }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ id: "m1", memory: "original text" }), { status: 200 });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    const res = await c.update("m1", { metadata: { pinned: true } });
    expect(res.memory).toBe("original text");
  });

  test("throws when text is missing AND the memory has no text either", async () => {
    mockFetchOnce(200, { id: "m1" }); // no `memory` field
    const c = new SelfHostMemoryClient({ host: "http://h:1", apiKey: "k" });
    await expect(c.update("m1", { metadata: {} })).rejects.toThrow(/server requires 'text'/);
  });
});

describe("SelfHostMemoryClient — health()", () => {
  test("returns ok when /openapi.json responds 2xx (preferred check)", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/openapi.json")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const c = new SelfHostMemoryClient({ host: "http://h:1" });
    const h = await c.health();
    expect(h.ok).toBe(true);
    expect(h.status).toBe(200);
  });

  test("falls back to / when /openapi.json is missing", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/openapi.json")) {
        return new Response("nope", { status: 404 });
      }
      return new Response("hi", { status: 200 });
    }) as typeof fetch;
    const c = new SelfHostMemoryClient({ host: "http://h:1" });
    const h = await c.health();
    expect(h.ok).toBe(true);
  });

  test("returns ok=false when neither endpoint is reachable", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const c = new SelfHostMemoryClient({ host: "http://h:1" });
    const h = await c.health();
    expect(h.ok).toBe(false);
  });
});
