export * as ConfigContext from "./context"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

/** Fraction of the usable context window, expressed between 0 and 1. */
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export class Reduction extends Schema.Class<Reduction>("ConfigV2.Context.Reduction")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Reduce the context sent to the model when a request comes under context pressure",
  }),
  threshold: Fraction.pipe(Schema.optional).annotate({
    description: "Fraction of the usable context window at which reduction starts",
  }),
  error_turns: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "Number of assistant turns a failed tool call keeps its original input for",
  }),
}) {}

export class Protection extends Schema.Class<Protection>("ConfigV2.Context.Protection")({
  recent_turns: NonNegativeInt.pipe(Schema.optional).annotate({
    description: "Number of recent assistant turns that are never reduced",
  }),
  user_messages: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Keep every user message verbatim",
  }),
  tools: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional tool names whose recorded calls are never reduced",
  }),
  files: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Glob patterns whose file operations are never reduced",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Context")({
  reduction: Reduction.pipe(Schema.optional).annotate({
    description: "Dynamic context reduction behavior",
  }),
  protection: Protection.pipe(Schema.optional).annotate({
    description: "Content that context reduction must never touch",
  }),
}) {}
