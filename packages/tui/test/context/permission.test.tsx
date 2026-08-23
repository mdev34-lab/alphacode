/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ArgsProvider } from "../../src/context/args"
import { PermissionProvider, usePermission } from "../../src/context/permission"

describe("PermissionContext", () => {
  test("defaults to supervised mode when no args provided", () => {
    createRoot((dispose) => {
      let mode = ""
      function Consumer() {
        const permission = usePermission()
        mode = permission.mode
        return null
      }
      const Root = (
        <ArgsProvider>
          <PermissionProvider>
            <Consumer />
          </PermissionProvider>
        </ArgsProvider>
      )
      expect(mode).toBe("supervised")
      dispose()
    })
  })

  test("initializes to yolo mode when args.yolo or args.auto is true", () => {
    createRoot((dispose) => {
      let mode = ""
      function Consumer() {
        const permission = usePermission()
        mode = permission.mode
        return null
      }
      const Root = (
        <ArgsProvider yolo={true}>
          <PermissionProvider>
            <Consumer />
          </PermissionProvider>
        </ArgsProvider>
      )
      expect(mode).toBe("yolo")
      dispose()
    })
  })

  test("toggles yolo mode correctly via toggle() and toggleYolo()", () => {
    createRoot((dispose) => {
      let ctx: ReturnType<typeof usePermission> | undefined
      function Consumer() {
        ctx = usePermission()
        return null
      }
      const Root = (
        <ArgsProvider>
          <PermissionProvider>
            <Consumer />
          </PermissionProvider>
        </ArgsProvider>
      )
      expect(ctx!.mode).toBe("supervised")

      ctx!.toggle()
      expect(ctx!.mode).toBe("yolo")

      ctx!.toggle()
      expect(ctx!.mode).toBe("supervised")

      ctx!.toggleYolo()
      expect(ctx!.mode).toBe("yolo")

      ctx!.toggleYolo()
      expect(ctx!.mode).toBe("supervised")

      dispose()
    })
  })
})
