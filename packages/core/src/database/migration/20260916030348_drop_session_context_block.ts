import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916030348_drop_session_context_block",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_context_block_session_idx\`;`)
      // `IF EXISTS` because an install whose journal was seeded from the legacy Drizzle journal may
      // never have recorded the migration that created it, and a failed migration blocks startup.
      yield* tx.run(`DROP TABLE IF EXISTS \`session_context_block\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
