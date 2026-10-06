import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, AgentSvc.node])))

describe("config agent background", () => {
  it.instance(
    "agent.<name>.background is read from project config onto the agent",
    () =>
      Effect.gen(function* () {
        const agent = yield* AgentSvc.Service
        // Opted into synchronous execution: a delegation to `review` waits for the
        // result unless the caller asks for background execution.
        expect((yield* agent.get("review"))?.background).toBe(false)
        // Unset means the background default, and one agent's opt-in does not
        // reach another.
        expect((yield* agent.get("general"))?.background).toBeUndefined()
        expect((yield* agent.get("explore"))?.background).toBe(true)
      }),
    {
      git: true,
      config: {
        agent: {
          review: { mode: "subagent", background: false },
          explore: { mode: "subagent", background: true },
        },
      },
    },
  )

  test("background is a known agent key, not an option passthrough", () => {
    const decode = Schema.decodeUnknownSync(ConfigAgentV1.Info)
    expect(decode({ background: false }).background).toBe(false)
    expect(decode({ background: true }).background).toBe(true)
    expect(decode({}).background).toBeUndefined()
    // Unknown fields are silently routed into `options`, which the V1-to-V2
    // migration forwards into the provider request body. `background` configures
    // the runtime instead, so it must not take that path.
    expect(decode({ background: false }).options).not.toHaveProperty("background")
    expect(decode({ custom: 1 }).options).toHaveProperty("custom")
  })

  test("an invalid background value fails the config file", () => {
    const parsed = Schema.decodeUnknownExit(ConfigV1.Info)({ agent: { review: { background: "sometimes" } } })
    expect(Exit.isFailure(parsed)).toBe(true)
    // Same convention as every other typed config field: a wrong type is a config
    // error naming the offending path, not a value that is quietly ignored.
    expect(() =>
      ConfigParse.schema(ConfigV1.Info, { agent: { review: { background: "sometimes" } } }, "config.json"),
    ).toThrow()
  })
})
