import os from "os"
import path from "path"
import { FSUtil } from "../fs-util"

const DARWIN_HOME = [
  "Music",
  "Pictures",
  "Movies",
  "Downloads",
  "Desktop",
  "Documents",
  "Public",
  "Applications",
  "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
]

const DARWIN_ROOT = ["/.DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]
const WIN32_HOME = ["AppData", "Downloads", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

export interface ProtectedOptions {
  platform?: NodeJS.Platform
  home?: string
  desktop?: string
}

/** Directory basenames to skip when scanning the home directory. */
export function names(options?: ProtectedOptions): ReadonlySet<string> {
  const platform = options?.platform ?? process.platform
  if (platform === "darwin") return new Set(DARWIN_HOME)
  if (platform === "win32") {
    const set = new Set(WIN32_HOME)
    set.add("Desktop")
    const desktop = options?.desktop !== undefined ? options.desktop : FSUtil.desktopDir()
    if (desktop) {
      set.add(path.win32.basename(desktop))
    }
    return set
  }
  return new Set()
}

/** Absolute paths that should never be watched, stated, or scanned. */
export function paths(options?: ProtectedOptions): string[] {
  const platform = options?.platform ?? process.platform
  const home = options?.home ?? (process.env.OPENCODE_TEST_HOME ?? os.homedir())
  if (platform === "darwin")
    return [
      ...DARWIN_HOME.map((name) => path.join(home, name)),
      ...DARWIN_LIBRARY.map((name) => path.join(home, "Library", name)),
      ...DARWIN_ROOT,
    ]
  if (platform === "win32") {
    const standard = WIN32_HOME.map((name) => path.join(home, name))
    const desktop = options?.desktop !== undefined ? options.desktop : FSUtil.desktopDir()
    return desktop ? [...standard, desktop] : standard
  }
  return []
}

export * as Protected from "./protected"
