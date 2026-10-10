import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { sessionAgent } from "../../src/session/session-agent"
import { NotFoundError } from "../../src/storage/storage"
import type { Session } from "../../src/session/session"

describe("session owner resolution", () => {
  test("pinned owner does not hydrate", async () => {
    const result = await Effect.runPromise(
      sessionAgent(
        {
          messages: () => {
            throw new Error("must not hydrate")
          },
        } as unknown as Session.Interface,
        { id: "pinned", agent: "code" } as Session.Info,
      ),
    )
    expect(result).toBe("code")
  })
  test("newest USER owner beats older user and newer assistant", async () => {
    const result = await Effect.runPromise(
      sessionAgent(
        {
          messages: () =>
            Effect.succeed([
              { info: { role: "user", agent: "work" } },
              { info: { role: "user", agent: "code" } },
              { info: { role: "assistant", agent: "work-review" } },
            ]),
        } as unknown as Session.Interface,
        { id: "fallback" } as Session.Info,
      ),
    )
    expect(result).toBe("code")
  })
  test("no user means no inferred tool owner", async () => {
    const result = await Effect.runPromise(
      sessionAgent(
        {
          messages: () => Effect.succeed([{ info: { role: "assistant", agent: "work" } }]),
        } as unknown as Session.Interface,
        { id: "empty" } as Session.Info,
      ),
    )
    expect(result).toBeUndefined()
  })
  // The helper is shared by the task tool (routing a review, addressing a
  // background notification) and the finish tool (deciding whether a reviewer
  // can be dispatched at all). An unreadable session is not the same fact as a
  // session with no user message: the second legitimately has no owner, the
  // first is unknown. Collapsing them would let a storage failure read as "no
  // reviewer", which is exactly the inference both callers must not make.
  test("an unreadable session fails rather than resolving to no owner", async () => {
    const exit = await Effect.runPromiseExit(
      sessionAgent(
        {
          messages: () => Effect.fail(new NotFoundError({ message: "Resource not found: session" })),
        } as unknown as Session.Interface,
        { id: "gone" } as Session.Info,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const failure = Cause.squash(exit.cause)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("Cannot resolve which reviewer to dispatch")
    expect((failure as Error).message).toContain("gone")
    expect((failure as Error).message).toContain("Resource not found: session")
  })
})
