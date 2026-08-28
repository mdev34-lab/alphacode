import { describe, test, expect, beforeEach } from "bun:test"
import { FSUtil } from "../../src/fs-util"
import {
  resolveDesktop,
  requireDesktop,
  clearDesktopCache,
  expandWindowsEnv,
  normalizeWindowsDesktopPath,
} from "../../src/filesystem/desktop"
import { Global } from "../../src/global"

describe("Desktop resolution", () => {
  beforeEach(() => {
    clearDesktopCache()
  })

  describe("Windows environment expansion & path normalization", () => {
    test("expands case-insensitive environment variables", () => {
      const env = {
        USERPROFILE: "C:\\Users\\JaneDoe",
        ONEDRIVE: "C:\\Users\\JaneDoe\\OneDrive",
      }
      expect(expandWindowsEnv("%USERPROFILE%\\Desktop", env)).toBe("C:\\Users\\JaneDoe\\Desktop")
      expect(expandWindowsEnv("%userprofile%\\Desktop", env)).toBe("C:\\Users\\JaneDoe\\Desktop")
      expect(expandWindowsEnv("%OneDrive%\\Desktop", env)).toBe("C:\\Users\\JaneDoe\\OneDrive\\Desktop")
    })

    test("falls back to fallbackHome for %USERPROFILE% when not in env", () => {
      expect(expandWindowsEnv("%USERPROFILE%\\Desktop", {}, "C:\\Users\\Fallback")).toBe(
        "C:\\Users\\Fallback\\Desktop",
      )
    })

    test("returns undefined when an environment variable cannot be resolved", () => {
      const env = { USERPROFILE: "C:\\Users\\JaneDoe" }
      expect(expandWindowsEnv("%UNKNOWN_VAR%\\Desktop", env)).toBeUndefined()
    })

    test("normalizes Windows paths and strips trailing slashes", () => {
      expect(normalizeWindowsDesktopPath("C:/Users/JaneDoe/Desktop/")).toBe("C:\\Users\\JaneDoe\\Desktop")
      expect(normalizeWindowsDesktopPath("D:\\CustomDesktop\\")).toBe("D:\\CustomDesktop")
      expect(normalizeWindowsDesktopPath("C:\\")).toBe("C:\\")
      expect(normalizeWindowsDesktopPath("\\\\server\\share\\Desktop\\")).toBe("\\\\server\\share\\Desktop")
    })

    test("rejects non-absolute Windows paths", () => {
      expect(normalizeWindowsDesktopPath("Desktop")).toBeUndefined()
      expect(normalizeWindowsDesktopPath(".\\Desktop")).toBeUndefined()
      expect(normalizeWindowsDesktopPath("relative\\path\\Desktop")).toBeUndefined()
    })
  })

  describe("Windows Desktop resolution", () => {
    test("resolves standard Desktop from User Shell Folders without assuming username", () => {
      const execCommand = (cmd: string, args: string[]) => {
        if (args.some((a) => a.includes("User Shell Folders"))) {
          return `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\Desktop
`
        }
        throw new Error("unexpected command")
      }

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\CustomUser123",
        },
        execCommand,
      })

      expect(result).toBe("C:\\Users\\CustomUser123\\Desktop")
    })

    test("resolves redirected Desktop to OneDrive", () => {
      const execCommand = (cmd: string, args: string[]) => {
        if (args.some((a) => a.includes("User Shell Folders"))) {
          return `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    Desktop    REG_SZ    C:\\Users\\CustomUser123\\OneDrive - Corporate\\Desktop
`
        }
        throw new Error("unexpected command")
      }

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\CustomUser123",
        },
        execCommand,
      })

      expect(result).toBe("C:\\Users\\CustomUser123\\OneDrive - Corporate\\Desktop")
    })

    test("resolves redirected Desktop on another drive (e.g. D:\\)", () => {
      const execCommand = (cmd: string, args: string[]) => {
        if (args.some((a) => a.includes("User Shell Folders"))) {
          return `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    Desktop    REG_EXPAND_SZ    D:\\Redirected\\Desktop
`
        }
        throw new Error("unexpected command")
      }

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\AnyUser",
        },
        execCommand,
      })

      expect(result).toBe("D:\\Redirected\\Desktop")
    })

    test("resolves redirected Desktop on a UNC network share", () => {
      const execCommand = (cmd: string, args: string[]) => {
        if (args.some((a) => a.includes("User Shell Folders"))) {
          return `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    Desktop    REG_SZ    \\\\storage\\users$\\john\\Desktop
`
        }
        throw new Error("unexpected command")
      }

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\john",
        },
        execCommand,
      })

      expect(result).toBe("\\\\storage\\users$\\john\\Desktop")
    })

    test("falls back to Shell Folders when User Shell Folders fails", () => {
      const execCommand = (cmd: string, args: string[]) => {
        if (args.some((a) => a.includes("User Shell Folders"))) {
          throw new Error("key not found")
        }
        if (args.some((a) => a.includes("Shell Folders"))) {
          return `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders
    Desktop    REG_SZ    C:\\Users\\FallbackUser\\Desktop
`
        }
        throw new Error("unexpected command")
      }

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\FallbackUser",
        },
        execCommand,
      })

      expect(result).toBe("C:\\Users\\FallbackUser\\Desktop")
    })

    test("falls back to PowerShell when reg queries fail", () => {
      const execCommand = (cmd: string, args: string[]) => {
        if (cmd.includes("reg")) {
          throw new Error("reg failed")
        }
        if (cmd.includes("powershell") || args.some((a) => a.includes("GetFolderPath"))) {
          return "C:\\Users\\PowerShellUser\\Desktop\r\n"
        }
        throw new Error("unexpected command")
      }

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\PowerShellUser",
        },
        execCommand,
      })

      expect(result).toBe("C:\\Users\\PowerShellUser\\Desktop")
    })

    test("returns undefined on failure instead of fabricating a plausible-looking path", () => {
      const execCommand = () => {
        throw new Error("All discovery mechanisms failed")
      }

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\Admin",
        },
        execCommand,
      })

      // Must NOT return "C:\\Users\\Admin\\Desktop"
      expect(result).toBeUndefined()
    })

    test("returns undefined when registry contains unresolvable environment variable", () => {
      const execCommand = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    Desktop    REG_EXPAND_SZ    %NONEXISTENT_DRIVE%\\Desktop
`

      const result = resolveDesktop({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\Admin",
        },
        execCommand,
      })

      expect(result).toBeUndefined()
    })

    test("requireDesktop throws when resolution fails", () => {
      const execCommand = () => {
        throw new Error("Discovery failed")
      }

      expect(() =>
        requireDesktop({
          platform: "win32",
          env: { SystemRoot: "C:\\Windows" },
          execCommand,
        }),
      ).toThrow("Failed to resolve operating system Desktop directory")
    })
  })

  describe("macOS (Darwin) Desktop resolution", () => {
    test("resolves to conventional ~/Desktop", () => {
      const result = resolveDesktop({
        platform: "darwin",
        homedir: "/Users/testuser",
      })

      expect(result).toBe("/Users/testuser/Desktop")
    })

    test("returns undefined when homedir is unavailable", () => {
      const result = resolveDesktop({
        platform: "darwin",
        homedir: "",
        env: {},
      })

      expect(result).toBeUndefined()
    })
  })

  describe("Linux Desktop resolution", () => {
    test("respects XDG_DESKTOP_DIR environment variable", () => {
      const result = resolveDesktop({
        platform: "linux",
        env: { XDG_DESKTOP_DIR: "/mnt/data/CustomDesktop" },
        homedir: "/home/testuser",
      })

      expect(result).toBe("/mnt/data/CustomDesktop")
    })

    test("expands $HOME in XDG_DESKTOP_DIR environment variable", () => {
      const result = resolveDesktop({
        platform: "linux",
        env: { XDG_DESKTOP_DIR: "$HOME/Bureau" },
        homedir: "/home/testuser",
      })

      expect(result).toBe("/home/testuser/Bureau")
    })

    test("parses XDG_DESKTOP_DIR from user-dirs.dirs file", () => {
      const configFile = "/home/testuser/.config/user-dirs.dirs"
      const readConfigFile = (fp: string) => {
        if (fp === configFile) {
          return `
# This file is written by xdg-user-dirs-update
XDG_DESKTOP_DIR="$HOME/Schreibtisch"
XDG_DOWNLOAD_DIR="$HOME/Downloads"
`
        }
        return undefined
      }

      const result = resolveDesktop({
        platform: "linux",
        homedir: "/home/testuser",
        configDir: "/home/testuser/.config",
        readConfigFile,
      })

      expect(result).toBe("/home/testuser/Schreibtisch")
    })

    test("falls back to ~/Desktop when no XDG config is present", () => {
      const result = resolveDesktop({
        platform: "linux",
        homedir: "/home/testuser",
        configDir: "/home/testuser/.config",
        readConfigFile: () => undefined,
      })

      expect(result).toBe("/home/testuser/Desktop")
    })

    test("returns undefined when homedir is unavailable on Linux", () => {
      const result = resolveDesktop({
        platform: "linux",
        homedir: "",
        env: {},
        readConfigFile: () => undefined,
      })

      expect(result).toBeUndefined()
    })
  })

  describe("FSUtil integration", () => {
    test("FSUtil.desktopDir provides canonical desktop resolution", () => {
      const result = FSUtil.desktopDir({
        platform: "win32",
        env: {
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\FSUser",
        },
        execCommand: () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    Desktop    REG_SZ    D:\\FSUserDesktop
`,
      })

      expect(result).toBe("D:\\FSUserDesktop")
    })

    test("FSUtil.requireDesktopDir succeeds when resolved", () => {
      const result = FSUtil.requireDesktopDir({
        platform: "darwin",
        homedir: "/Users/fsuser",
      })

      expect(result).toBe("/Users/fsuser/Desktop")
    })

    test("FSUtil.requireDesktopDir throws on resolution failure", () => {
      expect(() =>
        FSUtil.requireDesktopDir({
          platform: "win32",
          env: { SystemRoot: "C:\\Windows" },
          execCommand: () => {
            throw new Error("unavailable")
          },
        }),
      ).toThrow()
    })

    test("Global.Path.desktop exposes resolved desktop", () => {
      // In this test runner environment, Global.Path.desktop resolves the host desktop
      const desktop = Global.Path.desktop
      if (desktop !== undefined) {
        expect(typeof desktop).toBe("string")
      }
    })
  })
})
