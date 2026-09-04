export * as ConfigContext from "./context"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

/** Fraction of the model context window, expressed between 0 and 1. */
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export class DynamicCompression extends Schema.Class<DynamicCompression>("ConfigV2.Context.DynamicCompression")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Allow selective range compression of completed conversation sections",
  }),
  mode: Schema.Literals(["range"]).pipe(Schema.optional).annotate({
    description: "Compression granularity; only contiguous range compression is supported",
  }),
  automatic: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Let the runtime compress on its own once context utilization becomes critical",
  }),
  min_context: Fraction.pipe(Schema.optional).annotate({
    description: "Utilization below which context is never reduced",
  }),
  max_context: Fraction.pipe(Schema.optional).annotate({
    description: "Utilization above which context reduction is mandatory",
  }),
  timeout_ms: PositiveInt.pipe(Schema.optional).annotate({
    description: "Time budget for one summarization request before the turn continues uncompressed",
  }),
}) {}

export class Deduplication extends Schema.Class<Deduplication>("ConfigV2.Context.Deduplication")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Prune superseded duplicate tool outputs from the prepared context",
  }),
}) {}

export class PurgeErrors extends Schema.Class<PurgeErrors>("ConfigV2.Context.PurgeErrors")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Purge the inputs of failed tool calls once they are stale",
  }),
  turns: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "Number of assistant turns a failed tool input is retained for",
  }),
}) {}

export class Protection extends Schema.Class<Protection>("ConfigV2.Context.Protection")({
  recent_turns: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "Number of recent assistant turns that are never reduced",
  }),
  user_messages: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Keep every user message verbatim during compression",
  }),
  tools: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional tool names whose output is never reduced",
  }),
  files: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Glob patterns whose file operations are never reduced",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Context")({
  dynamic_compression: DynamicCompression.pipe(Schema.optional).annotate({
    description: "Selective conversation compression behavior",
  }),
  deduplication: Deduplication.pipe(Schema.optional).annotate({
    description: "Duplicate tool output pruning behavior",
  }),
  purge_errors: PurgeErrors.pipe(Schema.optional).annotate({
    description: "Stale failed tool input purging behavior",
  }),
  protection: Protection.pipe(Schema.optional).annotate({
    description: "Content that context management must never reduce",
  }),
  payload_bytes: PositiveInt.pipe(Schema.optional).annotate({
    description: "Hard serialized request byte budget enforced before a provider request is sent",
  }),
}) {}
