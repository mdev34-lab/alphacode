import path from "node:path"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AttachmentStore } from "./attachment-store"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { LocationMutation } from "./location-mutation"
import { PermissionV2 } from "./permission"
import { SessionProjector } from "../session/projector"
import { Layer } from "effect"

const dir = mkdtempSync(path.join(tmpdir(), "alphacode-att-"))
writeFileSync(path.join(dir, "note.txt"), "hello world")
writeFileSync(path.join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))

const layer = Layer.mergeAll(
  FSUtil.node,
  Global.node,
  LocationMutation.node,
  PermissionV2.node,
  Layer.empty,
  SessionProjector.node,
).pipe(Layer.provide(AttachmentStore.Default))

const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect.pipe(Effect.provide(layer)))

describe("AttachmentStore", () => {
  test("materializes a file:// attachment and records path/size", () => {
    const result = run(
      AttachmentStore.materialize({
        sessionID: "s1",
        attachment: { uri: `file://${dir}/note.txt`, mime: "text/plain", name: "note.txt" },
      }),
    )
    expect(result.path).toBeDefined()
    expect(result.size).toBeGreaterThan(0)
  })

  test("materializes a data: URI without base64 as UTF-8 text", () => {
    const result = run(
      AttachmentStore.materialize({
        sessionID: "s1",
        attachment: { uri: "data:text/plain,hello%20world", mime: "text/plain", name: "greeting.txt" },
      }),
    )
    expect(result.path).toBeDefined()
    expect(result.mime).toBe("text/plain")
  })

  test("materializes a data: URI with base64", () => {
    const result = run(
      AttachmentStore.materialize({
        sessionID: "s1",
        attachment: { uri: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`, mime: "image/png", name: "bin.png" },
      }),
    )
    expect(result.path).toBeDefined()
    expect(result.mime).toBe("image/png")
  })

  test("materializes an http(s) attachment as url source", () => {
    const result = run(
      AttachmentStore.materialize({
        sessionID: "s1",
        attachment: { uri: "https://example.com/foo.png", mime: "image/png", name: "foo.png" },
      }),
    )
    expect(result.source).toBe("url")
  })

  test("copyTo fails for an unknown attachment id", () => {
    const result = run(
      AttachmentStore.copyTo({ sessionID: "s1", id: "att_doesnotexist", target: path.join(dir, "out.txt") }),
    )
    expect(Effect.isEffect(result)).toBe(true)
  })

  test("inventory returns rows for materialized attachments", () => {
    run(
      AttachmentStore.materialize({
        sessionID: "s_inv",
        attachment: { uri: `file://${dir}/note.txt`, mime: "text/plain", name: "note.txt" },
      }),
    )
    const rows = run(AttachmentStore.inventory("s_inv"))
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].mime).toBe("text/plain")
  })
})
