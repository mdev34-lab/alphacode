import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

describe("Rpc client", () => {
  test("rejects pending calls when the transport closes", async () => {
    const target = {
      postMessage() {},
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onclose: null as ((error: Error) => void) | null,
    }

    const client = Rpc.client<{ work: (input: string) => Promise<string> }>(target)
    const pending = client.call("work", "input")
    target.onclose?.(new Error("worker crashed"))

    await expect(pending).rejects.toThrow("worker crashed")
  })
})
