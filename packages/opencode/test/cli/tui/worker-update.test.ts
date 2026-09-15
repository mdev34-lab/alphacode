import { expect, test } from "bun:test"
import { rpc } from "../../../src/cli/tui/worker"
import { Rpc } from "../../../src/util/rpc"

test("TUI worker no longer exposes checkUpgrade over RPC", async () => {
  try {
    const reply = await Rpc.handleRequest(
      rpc,
      JSON.stringify({ type: "rpc.request", id: 7, method: "checkUpgrade", input: { directory: process.cwd() } }),
    )

    expect(JSON.parse(reply ?? "")).toEqual({
      type: "rpc.error",
      id: 7,
      error: "Unknown RPC method: checkUpgrade",
    })
  } finally {
    await rpc.shutdown()
  }
})
