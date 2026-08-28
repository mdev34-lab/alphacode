import { describe, test, expect } from "bun:test"
import { Protected } from "../../src/filesystem/protected"
import path from "path"

describe("Protected filesystem paths", () => {
  describe("Windows protected paths", () => {
    test("includes redirected Desktop and does not assume C:\\Users\\...\\Desktop", () => {
      const home = "C:\\Users\\TestUser"
      const redirectedDesktop = "D:\\Redirected\\Desktop"

      const paths = Protected.paths({
        platform: "win32",
        home,
        desktop: redirectedDesktop,
      })

      expect(paths).toContain(redirectedDesktop)
      expect(paths).not.toContain(path.join(home, "Desktop"))
      expect(paths).toContain(path.join(home, "AppData"))
      expect(paths).toContain(path.join(home, "Downloads"))
      expect(paths).toContain(path.join(home, "Documents"))
      expect(paths).toContain(path.join(home, "OneDrive"))
    })

    test("includes OneDrive redirected Desktop on Windows", () => {
      const home = "C:\\Users\\TestUser"
      const oneDriveDesktop = "C:\\Users\\TestUser\\OneDrive\\Desktop"

      const paths = Protected.paths({
        platform: "win32",
        home,
        desktop: oneDriveDesktop,
      })

      expect(paths).toContain(oneDriveDesktop)
      expect(paths).toContain(path.join(home, "AppData"))
    })

    test("includes conventional Desktop when genuinely configured at conventional location", () => {
      const home = "C:\\Users\\TestUser"
      const standardDesktop = "C:\\Users\\TestUser\\Desktop"

      const paths = Protected.paths({
        platform: "win32",
        home,
        desktop: standardDesktop,
      })

      expect(paths).toContain(standardDesktop)
    })

    test("does not fabricate or assume a Desktop path when desktop resolution fails", () => {
      const home = "C:\\Users\\TestUser"

      const paths = Protected.paths({
        platform: "win32",
        home,
        desktop: undefined,
      })

      // Must NOT include any fabricated Desktop path
      expect(paths).not.toContain(path.join(home, "Desktop"))
      expect(paths).not.toContain("C:\\Users\\Admin\\Desktop")
      // Standard folders are still preserved
      expect(paths).toContain(path.join(home, "AppData"))
      expect(paths).toContain(path.join(home, "Downloads"))
    })
  })

  describe("macOS (Darwin) protected paths", () => {
    test("preserves existing macOS protected paths", () => {
      const home = "/Users/testuser"
      const paths = Protected.paths({
        platform: "darwin",
        home,
      })

      expect(paths).toContain(path.join(home, "Desktop"))
      expect(paths).toContain(path.join(home, "Downloads"))
      expect(paths).toContain(path.join(home, "Documents"))
      expect(paths).toContain(path.join(home, "Library", "Application Support/com.apple.TCC"))
      expect(paths).toContain("/.Spotlight-V100")
    })
  })

  describe("Protected names", () => {
    test("Windows names protect basename of Desktop located inside home", () => {
      const home = "C:\\Users\\TestUser"
      const names = Protected.names({
        platform: "win32",
        home,
        desktop: path.join(home, "MyDesk"),
      })

      expect(names.has("MyDesk")).toBe(true)
      expect(names.has("AppData")).toBe(true)
      expect(names.has("Downloads")).toBe(true)
    })

    test("Windows names do not protect basename of Desktop redirected outside home", () => {
      const home = "C:\\Users\\TestUser"
      const names = Protected.names({
        platform: "win32",
        home,
        desktop: "D:\\CustomDesk",
      })

      // Must not skip an unrelated same-basename folder inside home
      expect(names.has("CustomDesk")).toBe(false)
      expect(names.has("Desktop")).toBe(false)
      // Absolute path is still protected via paths()
      expect(Protected.paths({ platform: "win32", home, desktop: "D:\\CustomDesk" })).toContain(
        "D:\\CustomDesk",
      )
    })

    test("Windows names protect conventional Desktop basename at home", () => {
      const home = "C:\\Users\\TestUser"
      const names = Protected.names({
        platform: "win32",
        home,
        desktop: path.join(home, "Desktop"),
      })

      expect(names.has("Desktop")).toBe(true)
    })

    test("Darwin names include standard macOS folders", () => {
      const names = Protected.names({ platform: "darwin" })
      expect(names.has("Desktop")).toBe(true)
      expect(names.has("Downloads")).toBe(true)
      expect(names.has("Library")).toBe(true)
    })
  })
})
