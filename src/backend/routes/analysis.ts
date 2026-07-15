// Bundle 3: Live Vector Pruner / Analysis (5 endpoints)
// Embeddings: @xenova/transformers BAAI/bge-base-en-v1.5 (CPU, lazy-loaded)
// LLM: Groq llama-3.3-70b-versatile (structured JSON output)
// Fact checking: Google Fact Check Tools API + Groq fallback

import { Hono } from "hono";
import type { Variables } from "../types";
import { embed, cosineSimilarity } from "../lib/embeddings";
import { llmChat, getLLMConfig } from "../lib/llm";

const analysis = new Hono<{ Variables: Variables }>();

// ─── /heartbeat ──────────────────────────────────────────────────────────────
// Cosine similarity between two texts using BGE-base embeddings.
// @xenova/transformers downloads the model (~400 MB) on first call, cached to disk.

analysis.post("/heartbeat", async (c) => {
  const body = await c.req.json<{ text_a?: string; text_b?: string }>().catch(() => null);
  if (!body?.text_a || !body?.text_b) {
    return c.json({ success: false, error: "'text_a' and 'text_b' required" }, 400);
  }

  try {
    const [vecA, vecB] = await Promise.all([embed(body.text_a), embed(body.text_b)]);
    const similarity = cosineSimilarity(vecA, vecB);
    return c.json({
      success: true,
      bundle: "live_vector_pruner",
      data: {
        similarity:       parseFloat(similarity.toFixed(6)),
        similarity_pct:   parseFloat((similarity * 100).toFixed(2)),
        vector_dims:      vecA.length,
        interpretation:
          similarity > 0.85 ? "very similar" :
          similarity > 0.6  ? "related" : "distinct",
        timestamp: Date.now(),
      },
    });
  } catch {
    return c.json({ success: false, error: "embedding model unavailable" }, 503);
  }
});

// ─── /entity-extractor ───────────────────────────────────────────────────────

analysis.post("/entity-extractor", async (c) => {
  const env = c.get("env");
  const body = await c.req.json<{ text?: string }>().catch(() => null);
  if (!body?.text) return c.json({ success: false, error: "'text' field required" }, 400);
  try {
    const content = await llmChat(getLLMConfig(env), {
      temperature: 0.1,
      maxTokens:   1024,
      jsonOutput:  true,
      messages: [
        {
          role:    "system",
          content: "Extract named entities from text. Return ONLY valid JSON: " +
            '{"entities":[{"text":string,"type":"PERSON"|"ORG"|"LOC"|"DATE"|"MONEY"|"PRODUCT"|"OTHER",' +
            '"confidence":"low"|"medium"|"high"}],"entity_count":number}',
        },
        { role: "user", content: body.text.slice(0, 3000) },
      ],
    });
    const data = JSON.parse(content);
    return c.json({ success: true, bundle: "live_vector_pruner", data });
  } catch {
    return c.json({ success: false, error: "LLM inference failed" }, 503);
  }
});

// ─── /context-ranker ─────────────────────────────────────────────────────────
// Ranks text chunks by cosine similarity to a query — pure embedding, no Qdrant needed.

analysis.post("/context-ranker", async (c) => {
  const body = await c.req
    .json<{ query?: string; chunks?: string[] }>()
    .catch(() => null);
  if (!body?.query || !Array.isArray(body.chunks) || body.chunks.length === 0) {
    return c.json({ success: false, error: "'query' string and 'chunks' array required" }, 400);
  }

  try {
    const queryVec   = await embed(body.query);
    const chunkVecs  = await Promise.all(body.chunks.map(embed));

    const ranked = body.chunks
      .map((chunk, i) => ({
        index: i,
        chunk,
        score: parseFloat(cosineSimilarity(queryVec, chunkVecs[i]).toFixed(6)),
      }))
      .sort((a, b) => b.score - a.score);

    return c.json({
      success: true,
      bundle: "live_vector_pruner",
      data: { ranked, query_vector_dims: queryVec.length, timestamp: Date.now() },
    });
  } catch {
    return c.json({ success: false, error: "embedding model unavailable" }, 503);
  }
});

// ─── /bias-detector ──────────────────────────────────────────────────────────

analysis.post("/bias-detector", async (c) => {
  const env = c.get("env");
  const body = await c.req.json<{ text?: string }>().catch(() => null);
  if (!body?.text) return c.json({ success: false, error: "'text' field required" }, 400);
  try {
    const content = await llmChat(getLLMConfig(env), {
      temperature: 0.1,
      maxTokens:   1024,
      jsonOutput:  true,
      messages: [
        {
          role:    "system",
          content: "Detect framing bias in text. Return ONLY valid JSON: " +
            '{"bias_detected":boolean,"bias_types":["framing"|"sentiment"|"loaded_language"|"omission"|"selection"],' +
            '"confidence":"low"|"medium"|"high","bias_score":number,' +
            '"examples":[{"phrase":string,"type":string,"explanation":string}],"summary":string}',
        },
        { role: "user", content: body.text.slice(0, 3000) },
      ],
    });
    const data = JSON.parse(content);
    return c.json({ success: true, bundle: "live_vector_pruner", data });
  } catch {
    return c.json({ success: false, error: "LLM inference failed" }, 503);
  }
});

// ─── /fact-linkage ───────────────────────────────────────────────────────────
// Primary: Google Fact Check Tools API (free, requires key from console.cloud.google.com)
// Fallback: Groq LLM grounding analysis

analysis.post("/fact-linkage", async (c) => {
  const env = c.get("env");
  const body = await c.req
    .json<{ claim?: string; language?: string }>()
    .catch(() => null);
  if (!body?.claim) return c.json({ success: false, error: "'claim' field required" }, 400);

  // Attempt Google Fact Check Tools API first
  if (env.GOOGLE_FACTCHECK_API_KEY) {
    try {
      const params = new URLSearchParams({
        query:        body.claim.slice(0, 512),
        languageCode: body.language ?? "en",
        key:          env.GOOGLE_FACTCHECK_API_KEY,
        pageSize:     "10",
      });
      const res  = await fetch(
        `https://factchecktools.googleapis.com/v1alpha1/claims:search?${params}`
      );
      const json = (await res.json()) as { claims?: ClaimReview[] };

      if (json.claims && json.claims.length > 0) {
        const mapped = json.claims.slice(0, 5).map((c) => ({
          claim_text:    c.text,
          claimant:      c.claimant,
          claim_date:    c.claimDate,
          reviews:       (c.claimReview ?? []).map((r) => ({
            publisher:    r.publisher?.name,
            url:          r.url,
            rating:       r.textualRating,
            review_date:  r.reviewDate,
          })),
        }));
        return c.json({
          success: true,
          bundle: "live_vector_pruner",
          data: {
            source:    "google_factcheck",
            claims:    mapped,
            verified:  mapped.filter((c) => c.reviews.length > 0).length,
            unverified: mapped.filter((c) => c.reviews.length === 0).length,
            timestamp: Date.now(),
          },
        });
      }
    } catch {
      // fall through to Groq
    }
  }

  // LLM fallback — Ollama primary, Groq backup
  try {
    const content = await llmChat(getLLMConfig(env), {
      temperature: 0.1,
      maxTokens:   1024,
      jsonOutput:  true,
      messages: [
        {
          role:    "system",
          content: "Analyze the factual accuracy of a claim based on your training knowledge. " +
            "Return ONLY valid JSON: " +
            '{"assessment":"likely_true"|"likely_false"|"misleading"|"unverifiable",' +
            '"confidence":"low"|"medium"|"high","reasoning":string,' +
            '"caveats":string,"sources_note":string}',
        },
        { role: "user", content: `Claim: ${body.claim.slice(0, 1000)}` },
      ],
    });
    const data = JSON.parse(content);
    return c.json({
      success: true,
      bundle: "live_vector_pruner",
      data: { source: "llm", ...data, timestamp: Date.now() },
    });
  } catch {
    return c.json({ success: false, error: "LLM inference failed" }, 503);
  }
});

// ─── /sentiment ──────────────────────────────────────────────────────────────

analysis.post("/sentiment", async (c) => {
  const env  = c.get("env");
  const body = await c.req.json<{ text?: string }>().catch(() => null);
  if (!body?.text) return c.json({ success: false, error: "'text' field required" }, 400);

  try {
    const content = await llmChat(getLLMConfig(env), {
      temperature: 0.0,
      maxTokens:   128,
      jsonOutput:  true,
      messages: [
        {
          role:    "system",
          content: "You are a sentiment classifier. Return ONLY valid JSON: " +
            '{"sentiment":"positive"|"negative"|"neutral","confidence":0.0-1.0,' +
            '"dominant_emotion":string,"brief_reason":string}',
        },
        { role: "user", content: body.text.slice(0, 2000) },
      ],
    });
    const parsed = JSON.parse(content);
    return c.json({
      success: true,
      bundle: "live_vector_pruner",
      data: {
        sentiment:        parsed.sentiment,
        confidence:       parseFloat((Number(parsed.confidence) || 0).toFixed(3)),
        dominant_emotion: parsed.dominant_emotion ?? null,
        brief_reason:     parsed.brief_reason ?? null,
        char_count:       body.text.length,
        timestamp:        Date.now(),
      },
    });
  } catch {
    return c.json({ success: false, error: "LLM inference failed" }, 503);
  }
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClaimReview {
  text:        string;
  claimant?:   string;
  claimDate?:  string;
  claimReview?: {
    publisher?: { name?: string };
    url?:        string;
    textualRating?: string;
    reviewDate?: string;
  }[];
}

export default analysis;
