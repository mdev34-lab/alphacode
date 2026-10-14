import { describe, expect, test } from "bun:test"
import { notificationCommand } from "../src/notification"

describe("native notification commands", () => {
  const title = '$(touch /tmp/injected); "quotes" & <xml>'
  const message = "line one\nline two ' ` $HOME"

  test("Windows keeps all user text out of PowerShell source", () => {
    const command = notificationCommand(title, message, "win32", {})!
    expect(command.cmd[0]).toBe("powershell.exe")
    expect(command.cmd).toContain("-STA")
    const script = Buffer.from(command.cmd.at(-1)!, "base64").toString("utf16le")
    expect(script).toContain("ShowBalloonTip")
    expect(script).toContain("finally")
    expect(script).not.toContain(title)
    expect(script).not.toContain(message)
    expect(JSON.parse(Buffer.from(command.env!.SILVERCODE_NOTIFICATION!, "base64").toString())).toEqual({
      title,
      message,
    })
  })

  test("macOS passes data as AppleScript argv, not source", () => {
    const command = notificationCommand(title, message, "darwin", {})!
    expect(command.cmd.slice(-3)).toEqual(["--", title, message])
    expect(command.cmd[2]).not.toContain(title)
  })

  test("Linux ends option parsing and does not play a second sound", () => {
    expect(notificationCommand("--help", message, "linux", { WAYLAND_DISPLAY: "wayland-0" })!.cmd).toEqual([
      "notify-send",
      "--app-name=silvercode",
      "--hint=boolean:suppress-sound:true",
      "--",
      "--help",
      message,
    ])
  })

  test("remote, headless and unsupported hosts use terminal fallback", () => {
    expect(notificationCommand(title, message, "linux", {})).toBeUndefined()
    expect(notificationCommand(title, message, "freebsd", {})).toBeUndefined()
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(
        notificationCommand(title, message, platform, { SSH_CONNECTION: "client server", DISPLAY: ":0" }),
      ).toBeUndefined()
    }
  })
})
