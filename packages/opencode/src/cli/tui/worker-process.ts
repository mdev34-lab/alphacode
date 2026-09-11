type WorkerExit = {
  code: number | null
  signal: string | number | null
}

type WorkerMessageTarget = {
  postMessage(data: string): void
  onmessage: ((event: MessageEvent<string>) => void) | null
  onclose: ((error: Error) => void) | null
}

type Subprocess = {
  readonly exitCode: number | null
  readonly signalCode: string | number | null
  readonly exited: Promise<number>
  send(message: string): void
  kill(signal?: string | number): void
  disconnect(): void
}

type SpawnOptions = {
  cwd?: string
  env?: Record<string, string>
  stdin?: "ignore"
  stdout?: "ignore" | "inherit"
  stderr?: "ignore" | "inherit"
  ipc: (message: string) => void
}

type Spawn = (command: string[], options: SpawnOptions) => Subprocess

const CRASH_SIGNALS = new Set(["SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGSEGV", "SIGSYS", "SIGTRAP"])
const CRASH_SIGNAL_NUMBERS = new Set([4, 5, 6, 7, 8, 11, 12])
const WINDOWS_CRASH_CODES = new Set([0xc0000005, 0xc000001d, 0xc0000094, 0xc0000409])
const MAX_RESTARTS = 3

function isCrash(signal: string | number | null, code: number | null) {
  if (typeof signal === "string") return CRASH_SIGNALS.has(signal)
  if (typeof signal === "number") return CRASH_SIGNAL_NUMBERS.has(signal)
  if (typeof code !== "number") return false
  return WINDOWS_CRASH_CODES.has(code >>> 0)
}

function describeExit(exit: WorkerExit) {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`
}

export interface WorkerProcessOptions {
  cwd?: string
  env?: Record<string, string>
  maxRestarts?: number
  onRestart?: () => void | Promise<void>
  log?: (message: string) => void
  spawn?: Spawn
}

export interface WorkerProcess extends WorkerMessageTarget {
  readonly restarted: Promise<void>
  readonly closed: Promise<WorkerExit>
  terminate(): Promise<void>
}

export function createWorkerProcess(target: string, options: WorkerProcessOptions = {}): WorkerProcess {
  const spawn = options.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions))
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS
  const log = options.log ?? console.error

  let current: Subprocess | undefined
  let stopping = false
  let restarts = 0
  let restarted = Promise.resolve()
  let resolveClosed!: (exit: WorkerExit) => void
  const closed = new Promise<WorkerExit>((resolve) => {
    resolveClosed = resolve
  })

  const transport = {} as WorkerProcess
  Object.defineProperties(transport, {
    restarted: {
      enumerable: true,
      get: () => restarted,
    },
    closed: {
      enumerable: true,
      value: closed,
    },
  })
  transport.onmessage = null
  transport.onclose = null
  transport.postMessage = (data) => {
    if (!current) throw new Error("Bun worker is not running")
    current.send(data)
  }
  transport.terminate = async () => {
    stopping = true
    current?.disconnect()
    current?.kill("SIGTERM")
    await current?.exited.catch(() => undefined)
  }

  const launch = () => {
    current = spawn([process.execPath, target], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      ipc(message) {
        transport.onmessage?.({ data: message } as MessageEvent<string>)
      },
    })

    const child = current
    void child.exited.then((code) => {
      if (child !== current) return

      const exit: WorkerExit = {
        code: typeof code === "number" ? code : null,
        signal: child.signalCode,
      }
      const crash = !stopping && isCrash(exit.signal, exit.code)
      transport.onclose?.(new Error(`Bun worker exited with ${describeExit(exit)}`))

      if (crash && restarts < maxRestarts) {
        restarts += 1
        log(`[alphacode] Bun worker crashed (${describeExit(exit)}); restarting (${restarts}/${maxRestarts})...`)
        let resolveReady!: () => void
        restarted = new Promise<void>((resolve) => {
          resolveReady = resolve
        })
        launch()
        Promise.resolve(options.onRestart?.())
          .catch((error) =>
            log(`[alphacode] worker restart hook failed: ${error instanceof Error ? error.message : String(error)}`),
          )
          .finally(() => resolveReady())
        return
      }

      resolveClosed(exit)
    })
  }

  launch()
  return transport
}

export function isWorkerCrash(signal: string | number | null, code: number | null) {
  return isCrash(signal, code)
}
