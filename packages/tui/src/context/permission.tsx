import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"

export type PermissionMode = "supervised" | "yolo"

export interface PermissionContext {
  /** Current active permission mode ("supervised" or "yolo"). */
  readonly mode: PermissionMode
  /** Set the permission mode explicitly. */
  set(mode: PermissionMode): void
  /** Toggle between supervised and yolo mode. */
  toggle(): void
  /** Toggle between supervised and yolo mode. */
  toggleYolo(): void
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: (): PermissionContext => {
    const args = useArgs()
    const initialMode: PermissionMode = args.yolo || args.auto ? "yolo" : "supervised"

    const [store, setStore] = createStore<{ mode: PermissionMode }>({
      mode: initialMode,
    })

    return {
      get mode() {
        return store.mode
      },
      set(mode: PermissionMode) {
        setStore("mode", mode)
      },
      toggle() {
        setStore("mode", store.mode === "yolo" ? "supervised" : "yolo")
      },
      toggleYolo() {
        setStore("mode", store.mode === "yolo" ? "supervised" : "yolo")
      },
    }
  },
})
