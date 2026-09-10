/**
 * ThreadStore persists threads so a process restart reuses the same upstream
 * chat instead of recreating it. One JSON file (`threads.json`) holds all
 * threads of one provider profile; keys are the canonical thread ids.
 */
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { WebChatThread } from "./types"

export interface ThreadStoreOptions {
  file?: string
}

const DEFAULT_SUBDIR = path.join("webchat", "threads.json")

export class ThreadStore {
  private readonly file: string
  private readonly threads = new Map<string, WebChatThread>()
  private loaded = false

  constructor(options: ThreadStoreOptions = {}) {
    this.file = options.file ?? path.join(Global.Path.data, DEFAULT_SUBDIR)
  }

  static inDataDir(): ThreadStore {
    return new ThreadStore()
  }

  private open(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.file, "utf8")
      const parsed = JSON.parse(raw) as { threads: WebChatThread[] }
      if (parsed && Array.isArray(parsed.threads)) {
        for (const thread of parsed.threads) {
          if (thread && typeof thread.id === "string") this.threads.set(thread.id, thread)
        }
      }
    } catch {
      // First run / corrupt state: start empty.
    }
  }

  get(id: string): WebChatThread | undefined {
    this.open()
    return this.threads.get(id)
  }

  all(): WebChatThread[] {
    this.open()
    return [...this.threads.values()]
  }

  put(thread: WebChatThread): void {
    this.open()
    this.threads.set(thread.id, thread)
    this.flush()
  }

  remove(id: string): void {
    this.open()
    if (this.threads.delete(id)) this.flush()
  }

  clear(): void {
    this.threads.clear()
    this.flush()
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = { threads: [...this.threads.values()] }
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8")
      fs.renameSync(tmp, this.file)
    } catch (error) {
      // Persistence is best-effort: a failed disk write must not kill a turn.
      console.error("[webchat] failed to persist threads", error)
    }
  }
}