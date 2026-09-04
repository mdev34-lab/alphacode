#!/usr/bin/env bun

/**
 * Cost of one context preparation, with and without the deterministic reduction ladder.
 *
 * `ContextManager.prepare` runs on every agent turn, before every provider request, so the first
 * case that matters is the boring one: a long session with no compression blocks, no duplicates and
 * no stale failures, where the whole pipeline is pure overhead.
 *
 * The second case is the worst one: a history far over the byte ceiling, constructed so that every
 * rung of `ContextBudget.reduce` has to run — no duplicates to find, no stale failures to purge,
 * nothing to collapse — and the drop loop walks the whole eligible prefix. That path is the only
 * part of preparation whose work grows with *how far over* the limit the payload is. Run from
 * `packages/core`:
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

/**
 * Deliberately unwinnable for the cheap rungs: every `read` call takes a distinct file argument,
 * so deduplication finds nothing; there are no failed calls, so error purging finds nothing; and
 * no output exceeds the scaffold ceiling, so the collapse rungs change nothing.
 */
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

/**
 * The ladder itself, timed directly. A ceiling of one kilobyte is unreachable for any of these
 * histories, which is the point: the ladder is sequential, so ending in the drop rung is the proof
 * that every earlier rung ran and declined, and the drop loop has to consider every droppable
 * message up to the protected window.
 */
const ladder = (messages: readonly SessionMessage.Message[], limit: number) => {
  const protection = ContextProtection.resolve(messages, { policy: settings.protection })
  return ContextBudget.reduce({ messages, policy: settings.protection, protection, limit })
}

const milliseconds = (runs: number, run: () => unknown) => {
  run()
  const start = Bun.nanoseconds()
  for (let index = 0; index < runs; index++) run()
  return (Bun.nanoseconds() - start) / runs / 1e6
}

/**
 * The naive alternative to the drop loop's arithmetic sizing: re-serialize the candidate list
 * after every removal. Measured once, directly, so the complexity argument in the spec is a
 * comparison of two runs rather than an estimate.
 */
const quadraticDrop = (messages: readonly SessionMessage.Message[]) => {
  const protection = ContextProtection.resolve(messages, { policy: settings.protection })
  const droppable = messages
    .slice(0, protection.recentFrom)
    .flatMap((message, index) => (protection.messageIDs.has(message.id) ? [] : [index]))
  let remaining = [...messages]
  for (const index of droppable) {
    if (Buffer.byteLength(JSON.stringify(remaining) ?? "", "utf8") <= 1024) break
    remaining = remaining.filter((_, item) => item !== index)
  }
  return remaining.length
}

for (const count of [100, 500, 2000, 8000]) {
  const messages = history(count)
  const size = (JSON.stringify(messages).length / 1024).toFixed(0)
  const reduction = ladder(messages, 1024)
  if (reduction.within) throw new Error("the benchmark ceiling must stay unreachable")
  if (reduction.steps.at(-1) !== "drop-oldest")
    throw new Error(`the worst case must end in the drop rung, got: ${reduction.steps.join(", ")}`)
  console.log(
    `${String(count).padStart(4)} messages (${size.padStart(4)} KiB): ` +
      `prepare ${milliseconds(20, () => prepare(messages)).toFixed(2)} ms, ` +
      `full ladder (ContextBudget.reduce, steps: ${reduction.steps.join(", ")}) ` +
      `${milliseconds(20, () => ladder(messages, 1024)).toFixed(2)} ms`,
  )
}

// The comparative claim: the drop loop priced arithmetically versus the naive re-serialization it
// replaced. Kept at 2,000 messages so the script stays quick; the curve above already proves how
// the arithmetic version continues to scale.
const largest = history(2000)
console.log(
  `drop loop @ 2000 messages: arithmetic sizing ${milliseconds(20, () => ladder(largest, 1024)).toFixed(2)} ms, ` +
    `naive re-serialization ${milliseconds(2, () => quadraticDrop(largest)).toFixed(2)} ms`,
)
