/** Native delivery for the existing attention host. No shell receives user text. */
const windowsScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SILVERCODE_NOTIFICATION)) | ConvertFrom-Json
$icon = New-Object System.Windows.Forms.NotifyIcon
$timer = New-Object System.Windows.Forms.Timer
try {
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Text = 'silvercode'
  $icon.BalloonTipTitle = $payload.title.Substring(0, [Math]::Min(63, $payload.title.Length))
  $icon.BalloonTipText = $payload.message
  $icon.Visible = $true
  $timer.Interval = 6000
  $timer.Add_Tick({ [System.Windows.Forms.Application]::ExitThread() })
  $timer.Start()
  $icon.ShowBalloonTip(5000)
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Dispose()
  $icon.Visible = $false
  $icon.Dispose()
}
`

const macScript = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`

type NotificationCommand = { cmd: string[]; env?: Record<string, string | undefined> }

export function notificationCommand(
  title: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NotificationCommand | undefined {
  // A remote TUI must notify the client terminal, not the server's desktop.
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return
  if (platform === "win32") {
    return {
      cmd: [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(windowsScript, "utf16le").toString("base64"),
      ],
      env: { ...env, SILVERCODE_NOTIFICATION: Buffer.from(JSON.stringify({ title, message })).toString("base64") },
    }
  }
  if (platform === "darwin") return { cmd: ["osascript", "-e", macScript, "--", title, message] }
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    return { cmd: ["notify-send", "--app-name=silvercode", "--hint=boolean:suppress-sound:true", "--", title, message] }
  }
}

export async function notifyNative(title: string, message: string) {
  const command = notificationCommand(title, message)
  if (!command) return false
  try {
    const child = Bun.spawn(command.cmd, {
      env: command.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 10_000,
      windowsHide: true,
    })
    return (await child.exited) === 0
  } catch {
    // Missing notify-send, disabled desktop services, etc. are a normal fallback.
    return false
  }
}
