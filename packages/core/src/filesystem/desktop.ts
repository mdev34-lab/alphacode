import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { spawnSync } from "node:child_process"

export interface DesktopResolverOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homedir?: string
  configDir?: string
  readConfigFile?: (filePath: string) => string | undefined
  execCommand?: (command: string, args: string[]) => string
}

let cachedDefaultDesktop: string | undefined | null = null

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const matchKey = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return matchKey ? env[matchKey] : undefined
}

function defaultExecCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Command ${command} exited with code ${result.status}: ${result.stderr || ""}`)
  }
  return result.stdout || ""
}

function defaultReadConfigFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
}

export function expandWindowsEnv(raw: string, env: NodeJS.ProcessEnv, fallbackHome?: string): string | undefined {
  let unresolvable = false
  const expanded = raw.replace(/%([^%]+)%/g, (_, name) => {
    const val = getEnv(env, name)
    if (val) {
      return val
    }
    if (name.toUpperCase() === "USERPROFILE" && fallbackHome) {
      return fallbackHome
    }
    unresolvable = true
    return ""
  })

  if (unresolvable) return undefined
  return expanded
}

export function normalizeWindowsDesktopPath(candidate: string): string | undefined {
  const normalized = path.win32.normalize(candidate.trim())
  const isDriveLetter = /^[A-Za-z]:[\\/]/.test(normalized)
  const isUnc = /^\\\\[^\\/]+[\\/][^\\/]+/.test(normalized)

  if (!isDriveLetter && !isUnc) {
    return undefined
  }

  // Strip trailing slashes unless it's the root drive (e.g. C:\)
  if (normalized.length > 3 && (normalized.endsWith("\\") || normalized.endsWith("/"))) {
    return normalized.replace(/[\\/]+$/, "")
  }
  return normalized
}

function parseRegQueryDesktop(stdout: string, valueName?: string): string | undefined {
  if (valueName) {
    const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = stdout.match(new RegExp(`^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, "im"))
    if (match) return match[1].trim()
  }
  const match = stdout.match(/^\s*(?:Desktop|\{754AC886-DF64-4C2C-865E-37E494E293C6\})\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)
  return match ? match[1].trim() : undefined
}

function resolveWindowsDesktop(options: DesktopResolverOptions): string | undefined {
  const env = options.env ?? process.env
  const homedir = options.homedir ?? (getEnv(env, "OPENCODE_TEST_HOME") ?? os.homedir())
  const execCommand = options.execCommand ?? defaultExecCommand
  const systemRoot = getEnv(env, "SystemRoot") ?? getEnv(env, "windir") ?? "C:\\Windows"
  const regExe = path.win32.join(systemRoot, "System32", "reg.exe")
  const regCommands = [regExe, "reg.exe", "reg"]

  const userShellFolderKeys = [
    "{754AC886-DF64-4C2C-865E-37E494E293C6}",
    "Desktop",
  ]

  // Step 1: Query User Shell Folders (authoritative source for redirected folders in Windows)
  for (const regCmd of regCommands) {
    let succeeded = false
    for (const valName of userShellFolderKeys) {
      try {
        const stdout = execCommand(regCmd, [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
          "/v",
          valName,
        ])
        const raw = parseRegQueryDesktop(stdout, valName)
        if (raw) {
          const expanded = expandWindowsEnv(raw, env, homedir)
          if (expanded) {
            const normalized = normalizeWindowsDesktopPath(expanded)
            if (normalized) return normalized
          }
        }
        succeeded = true
      } catch {
        // Continue trying other value names or commands
      }
    }
    if (succeeded) break
  }

  // Step 2: Query legacy Shell Folders
  for (const regCmd of regCommands) {
    try {
      const stdout = execCommand(regCmd, [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
        "/v",
        "Desktop",
      ])
      const raw = parseRegQueryDesktop(stdout, "Desktop")
      if (raw) {
        const expanded = expandWindowsEnv(raw, env, homedir)
        if (expanded) {
          const normalized = normalizeWindowsDesktopPath(expanded)
          if (normalized) return normalized
        }
      }
      break
    } catch {
      // Continue to next command or fallback
    }
  }

  // Step 3: Query via PowerShell [Environment]::GetFolderPath('Desktop')
  const powershellExe = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const psCommands = [powershellExe, "powershell.exe", "powershell"]
  for (const psCmd of psCommands) {
    try {
      const stdout = execCommand(psCmd, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')",
      ])
      const trimmed = stdout.trim().split(/\r?\n/)[0]?.trim()
      if (trimmed) {
        const normalized = normalizeWindowsDesktopPath(trimmed)
        if (normalized) return normalized
      }
      break
    } catch {
      // Try next powershell candidate
    }
  }

  // Failure mode: deterministic undefined. Never fabricate or assume %USERPROFILE%\Desktop.
  return undefined
}

function resolveDarwinDesktop(options: DesktopResolverOptions): string | undefined {
  const env = options.env ?? process.env
  const homedir = options.homedir ?? (env.OPENCODE_TEST_HOME ?? os.homedir())
  if (!homedir) return undefined
  return path.posix.normalize(path.posix.join(homedir, "Desktop"))
}

function resolveLinuxDesktop(options: DesktopResolverOptions): string | undefined {
  const env = options.env ?? process.env
  const homedir = options.homedir ?? (env.OPENCODE_TEST_HOME ?? os.homedir())
  const readConfigFile = options.readConfigFile ?? defaultReadConfigFile

  // 1. Environment variable XDG_DESKTOP_DIR
  if (env.XDG_DESKTOP_DIR) {
    const expanded = homedir
      ? env.XDG_DESKTOP_DIR.replace(/\$(?:HOME|\{HOME\})/g, homedir)
      : env.XDG_DESKTOP_DIR
    const normalized = path.posix.normalize(expanded.trim())
    if (path.posix.isAbsolute(normalized)) {
      return normalized
    }
  }

  // 2. ~/.config/user-dirs.dirs
  const configDir =
    options.configDir ?? (env.XDG_CONFIG_HOME || (homedir ? path.posix.join(homedir, ".config") : undefined))
  if (configDir) {
    const configFile = path.posix.join(configDir, "user-dirs.dirs")
    const content = readConfigFile(configFile)
    if (content) {
      const match = content.match(/^\s*XDG_DESKTOP_DIR\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m)
      const raw = match ? (match[1] ?? match[2] ?? match[3]) : undefined
      if (raw) {
        const expanded = homedir ? raw.replace(/\$(?:HOME|\{HOME\})/g, homedir) : raw
        const normalized = path.posix.normalize(expanded.trim())
        if (path.posix.isAbsolute(normalized)) {
          return normalized
        }
      }
    }
  }

  // 3. Fallback to ~/Desktop
  if (homedir) {
    return path.posix.normalize(path.posix.join(homedir, "Desktop"))
  }
  return undefined
}

export function resolveDesktop(options?: DesktopResolverOptions): string | undefined {
  if (options) {
    const platform = options.platform ?? process.platform
    if (platform === "win32") return resolveWindowsDesktop(options)
    if (platform === "darwin") return resolveDarwinDesktop(options)
    if (platform === "linux" || platform === "freebsd" || platform === "openbsd" || platform === "netbsd") {
      return resolveLinuxDesktop(options)
    }
    const env = options.env ?? process.env
    const homedir = options.homedir ?? (env.OPENCODE_TEST_HOME ?? os.homedir())
    return homedir ? path.resolve(path.join(homedir, "Desktop")) : undefined
  }

  if (cachedDefaultDesktop !== null) {
    return cachedDefaultDesktop
  }

  const platform = process.platform
  let resolved: string | undefined
  if (platform === "win32") {
    resolved = resolveWindowsDesktop({})
  } else if (platform === "darwin") {
    resolved = resolveDarwinDesktop({})
  } else if (platform === "linux" || platform === "freebsd" || platform === "openbsd" || platform === "netbsd") {
    resolved = resolveLinuxDesktop({})
  } else {
    const homedir = process.env.OPENCODE_TEST_HOME ?? os.homedir()
    resolved = homedir ? path.resolve(path.join(homedir, "Desktop")) : undefined
  }

  cachedDefaultDesktop = resolved
  return resolved
}

export function clearDesktopCache(): void {
  cachedDefaultDesktop = null
}

export function requireDesktop(options?: DesktopResolverOptions): string {
  const dir = resolveDesktop(options)
  if (!dir) {
    throw new Error("Failed to resolve operating system Desktop directory")
  }
  return dir
}

export * as Desktop from "./desktop"
