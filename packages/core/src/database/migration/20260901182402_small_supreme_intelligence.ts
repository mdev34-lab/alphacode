import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260901182402_small_supreme_intelligence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_context_block\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`start_message_id\` text NOT NULL,
          \`end_message_id\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`focus\` text,
          \`source_message_count\` integer NOT NULL,
          \`source_token_count\` integer NOT NULL,
          \`summary_token_count\` integer NOT NULL,
          \`nested\` text NOT NULL,
          \`absorbed_by\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_block_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_context_block_session_idx\` ON \`session_context_block\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
