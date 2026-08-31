import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CommandV2 } from "@opencode-ai/core/command"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}
      // MCP command templates are lazy: reading one resolves the remote MCP
      // prompt, so record their names instead of materializing them here.
      const lazyTemplates = new Set<string>()

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        lazyTemplates.add(name)
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      // Bridge this instance's commands into the V2 command store, which the
      // TUI command launcher (GET /api/command) reads.
      //
      // The V2 store is location-scoped: the V2 API serves CommandV2 from the
      // location layer of the LocationServiceMap, a different instance from
      // any CommandV2 compiled into this graph. The bridge therefore resolves
      // the location layer for this instance's directory — memoized and
      // shared with V2 requests for the same location — and registers the
      // transform on that instance. The transform is bound to this state's
      // scope, so when this instance's commands are disposed or invalidated
      // the transform is unregistered and the V2 store reloads without them.
      //
      // The bridge owns only the entries it writes itself: each run removes
      // the commands it bridged previously that are no longer present and
      // upserts the current set. Entries contributed by other V2 producers
      // (config and plugin command providers) are left untouched.
      //
      // Templates are bridged without forcing lazy resolution. Only MCP
      // command templates are lazy promises — reading one resolves the remote
      // MCP prompt — so materializing every template here would execute all
      // MCP prompts during command initialization, and one slow, unavailable,
      // or failing prompt would take command initialization down with it.
      // Concrete templates are copied verbatim; lazy ones stay unresolved in
      // the V2 store and are materialized when the command is executed.
      //
      // The lookup is optional: contexts without a LocationServiceMap (e.g.
      // the CLI runtime) have no V2 command store to bridge into, so the
      // legacy store stands alone there.
      const locationsOpt = Context.getOption(LocationServiceMap.Service)(yield* Effect.context())
      if (Option.isSome(locationsOpt)) {
        const locations = locationsOpt.value
        const bridgedNames = new Set<string>()
        yield* Effect.gen(function* () {
          const commandV2 = yield* CommandV2.Service
          yield* commandV2.transform((draft) => {
            for (const name of bridgedNames) {
              draft.remove(name)
            }
            bridgedNames.clear()
            for (const [name, info] of Object.entries(commands)) {
              bridgedNames.add(name)
              draft.update(name, (cmd) => {
                cmd.name = info.name
                // Non-MCP templates are concrete strings; MCP templates are
                // lazy promises that must not be read here, so they are
                // bridged unresolved.
                const template = lazyTemplates.has(name) ? "" : info.template
                cmd.template = typeof template === "string" ? template : ""
                cmd.description = info.description
                cmd.agent = info.agent
                if (info.model) {
                  const parsed = ModelV2.parse(info.model)
                  cmd.model = { id: parsed.modelID, providerID: parsed.providerID }
                }
                cmd.subtask = info.subtask
              })
            }
          })
        }).pipe(
          Effect.provide(
            // Build the location ref exactly as the V2 location middleware
            // does (including the explicit undefined workspaceID): the
            // location map keys entries by structural equality, where a
            // missing key differs from a key set to undefined.
            locations.get(
              Location.Ref.make({ directory: AbsolutePath.make(ctx.directory), workspaceID: undefined }),
            ),
          ),
        )
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, MCP.node, Skill.node],
})

export * as Command from "."
