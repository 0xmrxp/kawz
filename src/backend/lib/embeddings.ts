// Embedding helpers for Bundle 3 (Analysis / Vector Pruner).
// Uses @xenova/transformers running locally on CPU — no external API needed.
// Phase 5 will complete the full pipeline.

// @xenova/transformers has complex discriminated-union return types that are
// hard to express statically. Using `any` for the pipeline object is intentional
// for this Phase 1 stub — Phase 5 will add proper type narrowing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any = null;

async function getPipeline(): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!_pipeline) {
    const { pipeline } = await import("@xenova/transformers");
    _pipeline = await pipeline("feature-extraction", "Xenova/bge-base-en-v1.5");
  }
  return _pipeline;
}

export type EmbeddingVector = number[];

export async function embed(text: string): Promise<EmbeddingVector> {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as ArrayLike<number>) as EmbeddingVector;
}

// Cosine similarity between two same-length vectors, returns -1..1.
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
