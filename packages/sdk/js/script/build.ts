#!/usr/bin/env bun
// Temporary SDK-build diagnostics. No forced exit, retries, or budget changes.
const sdkDiagnosticsProcess = process as typeof process & {
  _getActiveHandles?: () => unknown[]
  _getActiveRequests?: () => unknown[]
}
let sdkBuildPhase = "starting"
const sdkBuildStartedAt = Date.now()
function sdkBuildDiagnostic(event: string) {
  const names = (items: unknown[] | undefined) => items?.map((item) =>
    (item as { constructor?: { name?: string } })?.constructor?.name ?? "unknown")
  console.error("[sdk-build]", JSON.stringify({
    event, phase: sdkBuildPhase, pid: process.pid, ppid: process.ppid,
    elapsedMs: Date.now() - sdkBuildStartedAt,
    handles: names(sdkDiagnosticsProcess._getActiveHandles?.()),
    requests: names(sdkDiagnosticsProcess._getActiveRequests?.()),
  }))
}
function sdkBuildPhaseStart(phase: string) {
  sdkBuildPhase = phase
  sdkBuildDiagnostic("start")
}
const sdkBuildHeartbeat = setInterval(() => sdkBuildDiagnostic("pending"), 30_000)
sdkBuildHeartbeat.unref()
process.on("beforeExit", () => sdkBuildDiagnostic("beforeExit"))
process.on("exit", () => sdkBuildDiagnostic("exit"))

import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

sdkBuildPhaseStart("generate")
await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)
sdkBuildDiagnostic("done")

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

sdkBuildPhaseStart("create-client")
await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

sdkBuildDiagnostic("done")
sdkBuildPhaseStart("patch-generated")
const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

sdkBuildPhaseStart("prettier-gen")
await $`bun prettier --write src/gen`
sdkBuildDiagnostic("done")
sdkBuildPhaseStart("prettier-v2")
await $`bun prettier --write src/v2`
sdkBuildDiagnostic("done")
sdkBuildPhaseStart("remove-dist")
await $`rm -rf dist`
sdkBuildDiagnostic("done")
sdkBuildPhaseStart("tsc")
await $`bun tsc`
sdkBuildDiagnostic("done")
sdkBuildPhaseStart("remove-openapi")
await $`rm openapi.json`
sdkBuildDiagnostic("done")

sdkBuildPhase = "complete"
sdkBuildDiagnostic("script-end")
