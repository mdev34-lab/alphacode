export * as ContextState from "./state"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Effect } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import type { Database } from "../database/database"
import type { SessionSchema } from "../session/schema"
import { SessionContextBlockTable } from "./sql"
import type { CompressionBlock } from "./types"

type DatabaseService = Database.Interface["db"]

/** Compression block ids are prefixed so placeholder message ids stay recognizable. */
export const PREFIX = "cmp_"

export const createID = () => PREFIX + ascending()

const decode = (row: typeof SessionContextBlockTable.$inferSelect): CompressionBlock => ({
  id: row.id,
  startMessageID: row.start_message_id,
  endMessageID: row.end_message_id,
  summary: row.summary,
  focus: row.focus ?? undefined,
  createdAt: row.time_created,
  sourceMessageCount: row.source_message_count,
  sourceTokenCount: row.source_token_count,
  summaryTokenCount: row.summary_token_count,
  nested: row.nested,
})

/** Active blocks for a session, oldest first. Absorbed blocks stay stored but are not applied. */
export const list = Effect.fn("ContextState.list")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select()
    .from(SessionContextBlockTable)
    .where(and(eq(SessionContextBlockTable.session_id, sessionID), isNull(SessionContextBlockTable.absorbed_by)))
    .orderBy(asc(SessionContextBlockTable.time_created))
    .all()
    .pipe(Effect.orDie)
  return rows.map(decode)
})

export const insert = Effect.fn("ContextState.insert")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  block: CompressionBlock,
) {
  yield* db
    .insert(SessionContextBlockTable)
    .values({
      id: block.id,
      session_id: sessionID,
      start_message_id: block.startMessageID,
      end_message_id: block.endMessageID,
      summary: block.summary,
      focus: block.focus,
      source_message_count: block.sourceMessageCount,
      source_token_count: block.sourceTokenCount,
      summary_token_count: block.summaryTokenCount,
      nested: [...block.nested],
      time_created: block.createdAt,
    })
    .run()
    .pipe(Effect.orDie)
})

/**
 * Rewrite a block in place, used when the compiler normalizes overlapping ranges.
 *
 * The compiler cannot leave two blocks describing overlapping ranges, so the range it actually
 * projected is written back and becomes the authoritative one.
 */
export const widen = Effect.fn("ContextState.widen")(function* (db: DatabaseService, block: CompressionBlock) {
  yield* db
    .update(SessionContextBlockTable)
    .set({
      start_message_id: block.startMessageID,
      end_message_id: block.endMessageID,
      summary: block.summary,
      focus: block.focus,
      source_message_count: block.sourceMessageCount,
      source_token_count: block.sourceTokenCount,
      summary_token_count: block.summaryTokenCount,
      nested: [...block.nested],
    })
    .where(eq(SessionContextBlockTable.id, block.id))
    .run()
    .pipe(Effect.orDie)
})

/** Mark blocks whose content a wider compression has folded in. */
export const absorb = Effect.fn("ContextState.absorb")(function* (
  db: DatabaseService,
  ids: readonly string[],
  by: string,
) {
  if (ids.length === 0) return
  yield* db
    .update(SessionContextBlockTable)
    .set({ absorbed_by: by })
    .where(inArray(SessionContextBlockTable.id, [...ids]))
    .run()
    .pipe(Effect.orDie)
})

/** Drop blocks whose boundaries no longer resolve, such as after native compaction. */
export const remove = Effect.fn("ContextState.remove")(function* (db: DatabaseService, ids: readonly string[]) {
  if (ids.length === 0) return
  yield* db
    .delete(SessionContextBlockTable)
    .where(inArray(SessionContextBlockTable.id, [...ids]))
    .run()
    .pipe(Effect.orDie)
})

export const reset = Effect.fn("ContextState.reset")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  yield* db
    .delete(SessionContextBlockTable)
    .where(eq(SessionContextBlockTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})
