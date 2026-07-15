// Bundle: Agent Memory (4 endpoints)
// Qdrant REST API + local embeddings via lib/embeddings.
// Env deps: QDRANT_URL.
// No caching — memory ops must always reflect live state.

import { Hono } from "hono";
import type { Variables } from "../types";
import { embed } from "../lib/embeddings";

const agent = new Hono<{ Variables: Variables }>();

const COLLECTION    = "agent_memory";
const VECTOR_SIZE   = 768;
const DISTANCE      = "Cosine";
const MAX_TEXT_CHARS = 4000;

// ─── UUID helper ─────────────────────────────────────────────────────────────

function makePointId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── Qdrant helpers ──────────────────────────────────────────────────────────

async function qdrantRequest<T = unknown>(
  qdrantUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${qdrantUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qdrant ${res.status} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function ensureCollection(qdrantUrl: string): Promise<void> {
  try {
    await qdrantRequest(qdrantUrl, "PUT", `/collections/${COLLECTION}`, {
      vectors: { size: VECTOR_SIZE, distance: DISTANCE },
    });
  } catch (err) {
    // 400 / already-exists is fine — swallow it
    if (err instanceof Error && err.message.includes("already exists")) return;
    if (err instanceof Error && err.message.startsWith("Qdrant 400")) return;
    throw err;
  }
}

// ─── POST /store ──────────────────────────────────────────────────────────────

agent.post("/store", async (c) => {
  const env = c.get("env");
  let body: { text?: string; session_id?: string; tags?: string[] };
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }

  const { text, session_id, tags = [] } = body;
  if (!text)       return c.json({ success: false, error: "body.text required" }, 400);
  if (!session_id) return c.json({ success: false, error: "body.session_id required" }, 400);
  if (text.length > MAX_TEXT_CHARS) {
    return c.json(
      { success: false, error: `text exceeds max ${MAX_TEXT_CHARS} characters` },
      400
    );
  }

  try {
    await ensureCollection(env.QDRANT_URL);

    const vector    = await embed(text);
    const memory_id = makePointId();
    const timestamp = new Date().toISOString();
    const char_count = text.length;

    await qdrantRequest(env.QDRANT_URL, "PUT", `/collections/${COLLECTION}/points`, {
      points: [
        {
          id:      memory_id,
          vector,
          payload: { session_id, text, tags, timestamp, char_count },
        },
      ],
    });

    return c.json({
      success: true,
      bundle:  "agent_memory",
      data:    { memory_id, session_id, char_count, timestamp },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "store failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

// ─── POST /recall ─────────────────────────────────────────────────────────────

agent.post("/recall", async (c) => {
  const env = c.get("env");
  let body: { query?: string; session_id?: string; limit?: number; threshold?: number };
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }

  const { query, session_id, limit = 5, threshold = 0.5 } = body;
  if (!query)      return c.json({ success: false, error: "body.query required" }, 400);
  if (!session_id) return c.json({ success: false, error: "body.session_id required" }, 400);

  const topK = Math.min(Math.max(1, limit), 50);

  try {
    await ensureCollection(env.QDRANT_URL);

    const vector = await embed(query);

    const result = await qdrantRequest<{
      result?: { id: string; score: number; payload?: Record<string, unknown> }[];
    }>(env.QDRANT_URL, "POST", `/collections/${COLLECTION}/points/search`, {
      vector,
      limit:        topK,
      score_threshold: threshold,
      filter: {
        must: [{ key: "session_id", match: { value: session_id } }],
      },
      with_payload: true,
    });

    const memories = (result.result ?? []).map(r => ({
      memory_id:  r.id,
      score:      parseFloat(r.score.toFixed(4)),
      text:       r.payload?.["text"]  ?? "",
      tags:       r.payload?.["tags"]  ?? [],
      timestamp:  r.payload?.["timestamp"] ?? null,
    }));

    return c.json({
      success: true,
      bundle:  "agent_memory",
      data:    { session_id, query, results: memories, count: memories.length },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "recall failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

// ─── POST /forget ─────────────────────────────────────────────────────────────

agent.post("/forget", async (c) => {
  const env = c.get("env");
  let body: { memory_id?: string; session_id?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }

  const { memory_id, session_id } = body;
  if (!memory_id)  return c.json({ success: false, error: "body.memory_id required" }, 400);
  if (!session_id) return c.json({ success: false, error: "body.session_id required" }, 400);

  try {
    // Verify the point belongs to this session before deleting
    const point = await qdrantRequest<{
      result?: { payload?: Record<string, unknown> } | null;
    }>(env.QDRANT_URL, "GET", `/collections/${COLLECTION}/points/${memory_id}`);

    if (!point.result) {
      return c.json({ success: false, error: "memory not found" }, 404);
    }
    if (point.result.payload?.["session_id"] !== session_id) {
      return c.json({ success: false, error: "memory does not belong to this session" }, 403);
    }

    await qdrantRequest(env.QDRANT_URL, "POST", `/collections/${COLLECTION}/points/delete`, {
      points: [memory_id],
    });

    return c.json({
      success: true,
      bundle:  "agent_memory",
      data:    { memory_id, deleted: true },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return c.json({ success: false, error: "memory not found" }, 404);
    }
    const msg = err instanceof Error ? err.message : "forget failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

// ─── GET /list ────────────────────────────────────────────────────────────────

agent.get("/list", async (c) => {
  const env        = c.get("env");
  const session_id = c.req.query("session_id");
  const limit      = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "20")), 100);

  if (!session_id) {
    return c.json({ success: false, error: "session_id query param required" }, 400);
  }

  try {
    await ensureCollection(env.QDRANT_URL);

    // Scroll all points filtered by session_id
    const result = await qdrantRequest<{
      result?: {
        points?: { id: string; payload?: Record<string, unknown> }[];
        next_page_offset?: string | null;
      };
    }>(env.QDRANT_URL, "POST", `/collections/${COLLECTION}/points/scroll`, {
      filter: {
        must: [{ key: "session_id", match: { value: session_id } }],
      },
      limit,
      with_payload: true,
      with_vector:  false,
    });

    const points = result.result?.points ?? [];

    // Sort by timestamp descending
    const memories = points
      .map(p => ({
        memory_id:  p.id,
        text:       p.payload?.["text"]       ?? "",
        tags:       p.payload?.["tags"]       ?? [],
        char_count: p.payload?.["char_count"] ?? 0,
        timestamp:  p.payload?.["timestamp"]  ?? null,
      }))
      .sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp as string).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp as string).getTime() : 0;
        return tb - ta;
      });

    return c.json({
      success: true,
      bundle:  "agent_memory",
      data:    { session_id, memories, count: memories.length },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "list failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

export default agent;
