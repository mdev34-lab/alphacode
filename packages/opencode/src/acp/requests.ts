import type { AnyMessage, Stream } from "@agentclientprotocol/sdk"

/**
 * The JSON-RPC ids of the requests this agent sends, read off the wire.
 *
 * Cancelling an editor dialog takes `$/cancel_request`, which is aimed by the JSON-RPC id of
 * the request to cancel, and the SDK pinned here (0.21.0) has no supported way to obtain one:
 * `requestPermission` resolves to the response only, `sendRequest` keeps the id to itself, and
 * the counter it allocates from belongs to a class the package does not export. What the SDK
 * does document is the stream it writes every message to — `AgentSideConnection` accepts any
 * `Stream` — so the id is taken from the outgoing message instead. That is protocol shape
 * (JSON-RPC 2.0 framing, `AnyMessage`), not an internal, and it keeps working across SDK
 * versions that rearrange their own plumbing.
 */
export namespace ACPRequests {
  /** A JSON-RPC id as the SDK types it on a request. `null` never reaches here. */
  export type ID = string | number

  export type Interface = {
    /** The stream to hand the SDK: `inner`, with every outgoing message observed. */
    readonly stream: (inner: Stream) => Stream
    /**
     * Pairs the params object that is about to be sent with the JSON-RPC id the SDK gives it,
     * so that id can be handed to `onCancel` later. Call before sending.
     */
    readonly track: (params: unknown, onCancel: (requestID: ID) => void) => void
    /**
     * Cancels the request that carried `params`: at once when its id is already known, and
     * otherwise the moment that request goes out, so a cancel that beats the write queue still
     * closes the dialog the editor is about to open.
     */
    readonly cancel: (params: unknown) => void
    /** Forgets `params`, unless a cancel is still waiting for that request to go out. */
    readonly drop: (params: unknown) => void
  }

  type Entry = {
    readonly onCancel: (requestID: ID) => void
    requestID?: ID
    cancelled: boolean
  }

  export function make(): Interface {
    // Keyed by the params object itself. The SDK hands it to the transport unchanged —
    // `requestPermission(params)` becomes `{ jsonrpc, id, method, params }` holding that very
    // object — so identity is exact, no field of the request has to be understood here, and two
    // prompts in flight at once cannot be told apart wrongly.
    const entries = new Map<unknown, Entry>()

    const fire = (entry: Entry, requestID: ID) => {
      try {
        entry.onCancel(requestID)
      } catch {
        // Cancelling is best effort, and this runs on the connection's write path: a callback
        // that throws must not take the connection down with it.
      }
    }

    const observe = (message: AnyMessage) => {
      // Notifications have no id to cancel by, and responses carry no params to match on.
      if (!("method" in message) || !("id" in message) || message.id === null) return
      const entry = entries.get(message.params)
      if (!entry) return
      entry.requestID = message.id
      if (!entry.cancelled) return
      entries.delete(message.params)
      fire(entry, message.id)
    }

    return {
      stream: (inner) => ({
        readable: inner.readable,
        // The same shape as the SDK's own `ndJsonStream` writable — a writer acquired and
        // released per message — so backpressure and write failures behave as they did.
        writable: new WritableStream<AnyMessage>({
          async write(message) {
            // Before the forward, so a cancel landing while this write is in flight already has
            // an id to aim at. The SDK's write queue keeps that cancel behind the request, and a
            // write that then fails leaves a client ignoring a cancel for a request it never saw.
            observe(message)
            const writer = inner.writable.getWriter()
            try {
              await writer.write(message)
            } finally {
              writer.releaseLock()
            }
          },
        }),
      }),
      track: (params, onCancel) => {
        entries.set(params, { onCancel, cancelled: false })
      },
      cancel: (params) => {
        const entry = entries.get(params)
        if (!entry) return
        if (entry.requestID === undefined) {
          // Still queued inside the SDK, so the cancel goes out the moment the request does.
          entry.cancelled = true
          return
        }
        entries.delete(params)
        fire(entry, entry.requestID)
      },
      drop: (params) => {
        const entry = entries.get(params)
        // A cancelled entry is kept: it is the only record that the request now on its way out
        // still needs cancelling, and it goes away when that cancel is sent.
        if (!entry || entry.cancelled) return
        entries.delete(params)
      },
    }
  }
}
