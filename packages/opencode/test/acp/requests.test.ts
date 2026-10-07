import { describe, expect, it } from "bun:test"
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { ACP } from "@/acp/agent"
import { ACPRequests } from "@/acp/requests"

/**
 * A stream that keeps whatever is written to it, so a test can put a message on the wire the
 * way the SDK does and see both what the tracker made of it and what it forwarded.
 */
function wire() {
  const forwarded: AnyMessage[] = []
  const inner: Stream = {
    readable: new ReadableStream<AnyMessage>({ start() {} }),
    writable: new WritableStream<AnyMessage>({
      write(message) {
        forwarded.push(message)
      },
    }),
  }
  return { forwarded, inner }
}

async function send(stream: Stream, message: AnyMessage) {
  const writer = stream.writable.getWriter()
  try {
    await writer.write(message)
  } finally {
    writer.releaseLock()
  }
}

const request = (id: number, params: unknown): AnyMessage => ({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params,
})

describe("acp request ids", () => {
  it("reads the id of a tracked request off the wire and cancels by it", async () => {
    const tracker = ACPRequests.make()
    const { forwarded, inner } = wire()
    const stream = tracker.stream(inner)
    const params = { sessionId: "ses_a", toolCall: { toolCallId: "call_1" } }
    const cancelled: ACPRequests.ID[] = []
    tracker.track(params, (requestID) => cancelled.push(requestID))

    await send(stream, request(7, params))
    // The message is forwarded untouched, and knowing its id is not yet a cancel.
    expect(forwarded).toEqual([request(7, params)])
    expect(cancelled).toEqual([])

    tracker.cancel(params)
    expect(cancelled).toEqual([7])
  })

  it("cancels a request that was still on its way out", async () => {
    const tracker = ACPRequests.make()
    const { forwarded, inner } = wire()
    const stream = tracker.stream(inner)
    const params = { sessionId: "ses_a" }
    const cancelled: ACPRequests.ID[] = []
    tracker.track(params, (requestID) => cancelled.push(requestID))

    // The SDK allocates the id while sending, so a cancel can be asked for before there is one.
    tracker.cancel(params)
    expect(cancelled).toEqual([])

    await send(stream, request(3, params))
    expect(cancelled).toEqual([3])
    expect(forwarded).toEqual([request(3, params)])
    // And it is not sent twice for the same request.
    tracker.cancel(params)
    expect(cancelled).toEqual([3])
  })

  it("tells two requests with equal params apart by the object that was sent", async () => {
    const tracker = ACPRequests.make()
    const { inner } = wire()
    const stream = tracker.stream(inner)
    const first = { sessionId: "ses_a", toolCall: { toolCallId: "call_1" } }
    const second = { sessionId: "ses_a", toolCall: { toolCallId: "call_1" } }
    const cancelledFirst: ACPRequests.ID[] = []
    const cancelledSecond: ACPRequests.ID[] = []
    tracker.track(first, (requestID) => cancelledFirst.push(requestID))
    tracker.track(second, (requestID) => cancelledSecond.push(requestID))

    await send(stream, request(1, first))
    await send(stream, request(2, second))

    tracker.cancel(second)
    expect(cancelledSecond).toEqual([2])
    expect(cancelledFirst).toEqual([])

    tracker.cancel(first)
    expect(cancelledFirst).toEqual([1])
  })

  it("takes no id from a notification or from a response", async () => {
    const tracker = ACPRequests.make()
    const { forwarded, inner } = wire()
    const stream = tracker.stream(inner)
    const params = { sessionId: "ses_a" }
    const cancelled: ACPRequests.ID[] = []
    tracker.track(params, (requestID) => cancelled.push(requestID))

    // A notification carries the params but no id to cancel by; a response carries an id but
    // nothing to match on. Neither may be mistaken for the request being tracked.
    await send(stream, { jsonrpc: "2.0", method: "session/update", params })
    await send(stream, { jsonrpc: "2.0", id: 9, result: {} })
    expect(cancelled).toEqual([])

    await send(stream, request(4, params))
    tracker.cancel(params)
    expect(cancelled).toEqual([4])
    expect(forwarded).toHaveLength(3)
  })

  it("forgets a request that is dropped", async () => {
    const tracker = ACPRequests.make()
    const { forwarded, inner } = wire()
    const stream = tracker.stream(inner)
    const params = { sessionId: "ses_a" }
    const cancelled: ACPRequests.ID[] = []
    tracker.track(params, (requestID) => cancelled.push(requestID))

    tracker.drop(params)
    await send(stream, request(5, params))
    tracker.cancel(params)
    expect(cancelled).toEqual([])
    expect(forwarded).toEqual([request(5, params)])
  })

  it("keeps a cancel that is still owed when the request is dropped", async () => {
    const tracker = ACPRequests.make()
    const { inner } = wire()
    const stream = tracker.stream(inner)
    const params = { sessionId: "ses_a" }
    const cancelled: ACPRequests.ID[] = []
    tracker.track(params, (requestID) => cancelled.push(requestID))

    // The prompt is finished with before its request reached the wire, which is exactly when
    // dropping it must not lose the cancel: the editor is still about to open that dialog.
    tracker.cancel(params)
    tracker.drop(params)
    await send(stream, request(6, params))
    expect(cancelled).toEqual([6])
  })

  it("observes the stream the agent hands the SDK, with the tracker it gives the service", async () => {
    // This is the composition `opencode acp` runs: the agent wraps the stream, and the service
    // it builds cancels through the same tracker. Two instances would mean an id read off the
    // wire is never the one a cancel is aimed by, and no dialog would ever be closed.
    const agent = ACP.init({ sdk: {} as OpencodeClient })
    const { forwarded, inner } = wire()
    const stream = agent.stream(inner)
    const params = { sessionId: "ses_a" }
    const cancelled: ACPRequests.ID[] = []
    agent.requests.track(params, (requestID) => cancelled.push(requestID))

    await send(stream, request(11, params))
    expect(forwarded).toEqual([request(11, params)])
    expect(stream.readable).toBe(inner.readable)

    agent.requests.cancel(params)
    expect(cancelled).toEqual([11])
  })

  it("keeps writing when a cancel callback throws", async () => {
    const tracker = ACPRequests.make()
    const { forwarded, inner } = wire()
    const stream = tracker.stream(inner)
    const params = { sessionId: "ses_a" }
    tracker.track(params, () => {
      throw new Error("cancel failed")
    })
    tracker.cancel(params)

    // Cancelling is best effort and runs on the connection's write path, so neither the write
    // that carries the request nor a later cancel may be taken down by it.
    await send(stream, request(8, params))
    expect(forwarded).toEqual([request(8, params)])
    expect(() => tracker.cancel(params)).not.toThrow()
  })
})
