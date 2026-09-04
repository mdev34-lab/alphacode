import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

/**
 * Compression metadata, stored separately from the canonical messages it summarizes.
 *
 * Deleting every row here only makes future requests larger; the conversation itself remains
 * independently recoverable from `session_message`.
 */
export const SessionContextBlockTable = sqliteTable(
  "session_context_block",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    start_message_id: text().$type<SessionMessage.ID>().notNull(),
    end_message_id: text().$type<SessionMessage.ID>().notNull(),
    summary: text().notNull(),
    focus: text(),
    source_message_count: integer().notNull(),
    source_token_count: integer().notNull(),
    summary_token_count: integer().notNull(),
    nested: text({ mode: "json" }).$type<string[]>().notNull(),
    absorbed_by: text(),
    ...Timestamps,
  },
  (table) => [index("session_context_block_session_idx").on(table.session_id)],
)
