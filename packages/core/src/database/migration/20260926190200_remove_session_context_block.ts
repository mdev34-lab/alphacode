import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926190200_remove_session_context_block",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_context_block_session_idx\`;`)
      yield* tx.run(`DROP TABLE \`session_context_block\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
