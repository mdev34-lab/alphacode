import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260605042240_add_context_epoch_agent",
  up(tx) {
    return Effect.gen(function* () {
      // NOTE: historical migration - do not edit.
      // The literal below is the value this migration wrote when it shipped.
      // Changing it would only affect databases that have never run it, leaving
      // existing installs on the old default while the code assumed the new one.
      // The builtin agent has since been renamed `build` -> `work`, and this
      // column is dropped again by 20260622142730_simplify_session_context_epoch,
      // so no data migration is required.
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`agent\` text DEFAULT 'build' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
