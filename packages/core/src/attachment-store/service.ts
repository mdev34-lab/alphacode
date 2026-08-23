import { Context, Effect } from "effect"
import { SessionSchema } from "../session/schema"
import { AgentV2 } from "../agent"
import { FileAttachment } from "../session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"

export interface MaterializeInput {
  readonly sessionID: SessionSchema.ID
  readonly agent?: AgentV2.ID
  readonly attachment: PromptInput.FileAttachment
}

export interface CopyInput {
  readonly sessionID: SessionSchema.ID
  readonly agent?: AgentV2.ID
  readonly id: string
  readonly target: string
}

export interface InventoryRow {
  readonly id: string
  readonly name?: string
  readonly mime: string
  readonly source: string
  readonly size?: number
  readonly unavailable?: boolean
}

export interface Interface {
  readonly materialize: (input: MaterializeInput) => Effect.Effect<FileAttachment>
  readonly inventory: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<InventoryRow>>
  readonly copyTo: (input: CopyInput) => Effect.Effect<{ readonly resource: string }, Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AttachmentStore") {}

export * as AttachmentStoreService from "./service"
