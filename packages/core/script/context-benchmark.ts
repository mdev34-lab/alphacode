#!/usr/bin/env bun

/**
 * Cost of one context preparation, with and without the deterministic reduction ladder.
 *
 * `ContextManager.prepare` runs on every agent turn, before every provider request, so the first
 * case that matters is the boring one: a long session with no compression blocks, no duplicates and
 * no stale failures, where the whole pipeline is pure overhead.
 *
 * The second case is the worst one: a history far over the byte ceiling, where `ContextBudget.reduce`
 * runs every rung of the ladder and ends up dropping messages one at a time. That path is the only
 * part of preparation whose work grows with *how far over* the limit the payload is, so it is
 * measured separately with a ceiling small enough to force every stage. Run from `packages/core`:
 *
 *   bun script/context-benchmark.ts
 */

import { DateTime } from "effect"
import { ContextBudget } from "../src/context/budget"
import { ContextDeduplicate } from "../src/context/deduplicate"
import { ContextInvariants } from "../src/context/invariants"
import { ContextPlaceholder } from "../src/context/placeholders"
import { ContextProtection } from "../src/context/protection"
import { ContextPurgeErrors } from "../src/context/purge-errors"
import { ContextSettings } from "../src/context/settings"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"

const created = DateTime.makeUnsafe(0)
const settings = ContextSettings.settings([])
const sessionID = SessionSchema.ID.make("ses_benchmark")

const history = (count: number): SessionMessage.Message[] =>
  Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? ({
          id: SessionMessage.ID.make(`msg_${index}`),
          type: "user",
          text: `question ${index} ${"detail ".repeat(20)}`,
          time: { created },
        } satisfies SessionMessage.Message)
      : ({
          id: SessionMessage.ID.make(`msg_${index}`),
          type: "assistant",
          agent: "build",
          model: { providerID: ProviderV2.ID.make("fake"), id: ModelV2.ID.make("fake-model") },
          content: [
            { type: "text", id: `t_${index}`, text: `answer ${index}` },
            {
              type: "tool",
              id: `call_${index}`,
              name: "read",
              time: { created },
              state: {
                status: "completed",
                input: { file: `src/file-${index}.ts` },
                structured: {},
                content: [
                  { type: "text", text: `contents of file ${index}\n${"export const value = 1\n".repeat(20)}` },
                ],
              },
            },
          ],
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created, completed: created },
        } satisfies SessionMessage.Message),
  )

/** The stages `prepareOnce` runs, in the same order, with nothing left to reduce. */
const prepare = (messages: readonly SessionMessage.Message[]) => {
  const protection = ContextProtection.resolve(messages, { policy: settings.protection })
  const placed = ContextPlaceholder.apply(sessionID, messages, [], protection.messageIDs)
  const raw = ContextBudget.measure(messages)
  const duplicates = ContextDeduplicate.plan(placed.messages, { policy: settings.protection, protection })
  const errors = ContextPurgeErrors.plan(placed.messages, {
    policy: settings.protection,
    turns: settings.purgeErrors.turns,
  })
  const reduced = ContextPurgeErrors.apply(ContextDeduplicate.apply(placed.messages, duplicates), errors)
  const measured = ContextBudget.measure(reduced)
  return raw.tokens + measured.bytes + ContextInvariants.check(messages, reduced).length
}

/** The ladder\'s worst case: every rung runs and the drop loop walks the whole eligible prefix. */
const ladder = (messages: readonly SessionMessage.Message[], limit: number) => {
  const protection = ContextProtection.resolve(messages, { policy: settings.protection })
  return ContextBudget.reduce({ messages, policy: settings.protection, protection, limit }).steps.length
}

const milliseconds = (runs: number, run: () => unknown) => {
  run()
  const start = Bun.nanoseconds()
  for (let index = 0; index < runs; index++) run()
  return (Bun.nanoseconds() - start) / runs / 1e6
}

for (const count of [100, 500, 2000]) {
  const messages = history(count)
  const size = (JSON.stringify(messages).length / 1024).toFixed(0)
  // A ceiling of one kilobyte is unreachable for any of these histories, which is the point: the
  // ladder cannot stop early and has to consider every droppable message.
  const reduction = milliseconds(20, () => ladder(messages, 1024))
  console.log(
    `${String(count).padStart(4)} messages (${size.padStart(4)} KiB): ` +
      `prepare ${milliseconds(20, () => prepare(messages)).toFixed(2)} ms, ` +
      `full ladder ${reduction.toFixed(2)} ms`,
  )
}
