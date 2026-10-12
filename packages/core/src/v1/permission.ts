export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@opencode-ai/schema/permission-v1"
import { ID } from "@opencode-ai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

// Distinct from RejectedError on purpose: a rejection ends the turn unless
// `experimental.continue_loop_on_deny` is set, while a timeout only fails the
// single tool call so the agent can pick another approach.
export class TimedOutError extends Schema.TaggedErrorClass<TimedOutError>()("PermissionTimedOutError", {
  seconds: Schema.Number,
}) {
  override get message() {
    return `Nobody responded to this permission request within ${this.seconds} second${this.seconds === 1 ? "" : "s"}, so it was automatically denied. Do not repeat the same call; continue with a different approach that does not need this permission.`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError | TimedOutError
