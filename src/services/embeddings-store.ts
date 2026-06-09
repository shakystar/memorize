import { getDb } from '../storage/db.js';

/**
 * Read/write the `embeddings` table (v8) — the derived, best-effort semantic
 * index for P3-c. One row per consolidated memory text. Vectors are stored as a
 * JSON `number[]` in a TEXT column (no native vector extension); cosine
 * similarity is computed in JS at query time (embeddings-service). This table is
 * maintained out-of-band by `ensureEmbeddings`, NOT by rebuildProjectProjection.
 */

export interface StoredEmbedding {
  entityId: string;
  /** Source kind — 'memory' for the round-1 long-term layer. */
  kind: string;
  /** Model that produced the vector; a mismatch triggers re-embedding. */
  model: string;
  /** Vector dimensionality (informational; cosine guards length anyway). */
  dim: number;
  vector: number[];
  /** Hash of the embedded text; a mismatch triggers re-embedding. */
  textHash: string;
  createdAt: string;
}

export interface EmbeddingRow {
  entityId: string;
  kind: string;
  model: string;
  vector: number[];
  textHash: string;
}

function parseRow(row: {
  entity_id: string;
  kind: string;
  model: string;
  vector: string;
  text_hash: string;
}): EmbeddingRow {
  return {
    entityId: row.entity_id,
    kind: row.kind,
    model: row.model,
    vector: JSON.parse(row.vector) as number[],
    textHash: row.text_hash,
  };
}

/** Insert or replace one memory's embedding (keyed by entity_id). */
export function upsertEmbedding(
  projectId: string,
  embedding: StoredEmbedding,
): void {
  getDb(projectId)
    .prepare(
      `INSERT INTO embeddings
         (entity_id, kind, model, dim, vector, text_hash, created_at)
       VALUES
         (@entityId, @kind, @model, @dim, @vector, @textHash, @createdAt)
       ON CONFLICT(entity_id) DO UPDATE SET
         kind       = excluded.kind,
         model      = excluded.model,
         dim        = excluded.dim,
         vector     = excluded.vector,
         text_hash  = excluded.text_hash,
         created_at = excluded.created_at`,
    )
    .run({
      entityId: embedding.entityId,
      kind: embedding.kind,
      model: embedding.model,
      dim: embedding.dim,
      vector: JSON.stringify(embedding.vector),
      textHash: embedding.textHash,
      createdAt: embedding.createdAt,
    });
}

/** All stored embeddings (optionally filtered by kind), vectors parsed. */
export function listEmbeddings(
  projectId: string,
  kind?: string,
): EmbeddingRow[] {
  const db = getDb(projectId);
  const rows = (
    kind
      ? db
          .prepare(
            'SELECT entity_id, kind, model, vector, text_hash FROM embeddings WHERE kind = ?',
          )
          .all(kind)
      : db
          .prepare(
            'SELECT entity_id, kind, model, vector, text_hash FROM embeddings',
          )
          .all()
  ) as Array<{
    entity_id: string;
    kind: string;
    model: string;
    vector: string;
    text_hash: string;
  }>;
  return rows.map(parseRow);
}

/** One embedding by entity id, or undefined. */
export function getEmbedding(
  projectId: string,
  entityId: string,
): EmbeddingRow | undefined {
  const row = getDb(projectId)
    .prepare(
      'SELECT entity_id, kind, model, vector, text_hash FROM embeddings WHERE entity_id = ?',
    )
    .get(entityId) as
    | {
        entity_id: string;
        kind: string;
        model: string;
        vector: string;
        text_hash: string;
      }
    | undefined;
  return row ? parseRow(row) : undefined;
}
