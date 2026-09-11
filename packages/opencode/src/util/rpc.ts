type Definition = {
  [method: string]: (input: any) => any
}

type Message = {
  type: string
  id?: number
  method?: string
  input?: unknown
  event?: string
  data?: unknown
}

async function handle(rpc: Definition, raw: string) {
  const parsed = JSON.parse(raw) as Message
  if (parsed.type !== "rpc.request" || parsed.method === undefined || parsed.id === undefined) return
  const result = await rpc[parsed.method](parsed.input)
  return JSON.stringify({ type: "rpc.result", result, id: parsed.id })
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const result = await handle(rpc, evt.data)
    if (result) postMessage(result)
  }
}

export function listenProcess(rpc: Definition) {
  process.on("message", async (message: string) => {
    const result = await handle(rpc, message)
    if (result) process.send?.(result)
  })
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function emitProcess(event: string, data: unknown) {
  process.send?.(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  onclose?: ((error: Error) => void) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data) as Message
    if (parsed.type === "rpc.result" && parsed.id !== undefined) {
      const request = pending.get(parsed.id)
      if (request) {
        request.resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.event" && parsed.event !== undefined) {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  target.onclose = (error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
