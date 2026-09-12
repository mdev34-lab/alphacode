<#Requires -Version 7.0
<#
.SYNOPSIS
  Pull a branch, build alphacode for the current platform, reinstall globally.

.DESCRIPTION
  1. Fetches origin/<Branch> and fast-forwards the local branch (default dev).
  2. Builds the current-platform binary only (bun run build -- --single).
  3. Copies the fresh binary to ~/.local/bin/alphacode.exe and smoke-tests it.

.PARAMETER Branch
  Branch to pull and build. Defaults to dev (tracked against origin).

.PARAMETER Version
  Version stamped into the build via OPENCODE_VERSION (Script.version honors
  the env var verbatim). When omitted the repo default applies: on the
  latest channel root package.json version + patch bump, otherwise a
  0.0.0-<branch>-<timestamp> preview version.

.PARAMETER AllowDirty
  Skip the clean-working-tree check. Uncommitted changes stay in place and
  end up in the binary.

.PARAMETER KeepDist
  Keep packages/opencode/dist after install. By default it is removed to
  leave the tree clean.

.PARAMETER SkipBuild
  Skip pull and build; reinstall from the existing packages/opencode/dist
  platform binary (e.g. after a previous run failed at the install step).

.PARAMETER KillRunning
  Stop running alphacode.exe processes before installing. Off by default:
  the installer renames the running binary aside (allowed on Windows) so a
  live TUI session is never killed. Use only when the rename swap fails.
#>
[CmdletBinding()]
param(
  [string]$Branch = "dev",
  [string]$Version = "",
  [switch]$AllowDirty,
  [switch]$KeepDist,
  [switch]$SkipBuild,
  [switch]$KillRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$opencodeDir = Join-Path $repoRoot "packages/opencode"
$distDir = Join-Path $opencodeDir "dist"
$destDir = Join-Path $HOME ".local/bin"
$destExe = Join-Path $destDir "alphacode.exe"
$destOld = "$destExe.old"

function Invoke-Step([string]$label, [scriptblock]$body) {
  Write-Host "`n=== $label ===" -ForegroundColor Cyan
  & $body
}

foreach ($cmd in @("git", "bun")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Required command not on PATH: $cmd"
  }
}
if (-not (Test-Path -LiteralPath $opencodeDir)) {
  throw "Expected opencode package at $opencodeDir (script moved?)"
}

if (-not $SkipBuild) {
  Invoke-Step "Pull origin/$Branch" {
    Push-Location -LiteralPath $repoRoot
    try {
      if (-not $AllowDirty -and (git status --porcelain --untracked-files=no)) {
        throw "Working tree has uncommitted changes. Commit/stash first, or pass -AllowDirty."
      }
      git fetch origin $Branch
      if ($LASTEXITCODE -ne 0) { throw "git fetch origin $Branch failed" }
      $current = (git branch --show-current).Trim()
      if ($current -ne $Branch) {
        git checkout $Branch
        if ($LASTEXITCODE -ne 0) { throw "git checkout $Branch failed" }
      }
      git pull --ff-only origin $Branch
      if ($LASTEXITCODE -ne 0) { throw "Fast-forward pull failed (branch diverged?)" }
      git log --oneline -1
    } finally {
      Pop-Location
    }
  }

  Invoke-Step "Build current platform (bun run build -- --single)" {
    Push-Location -LiteralPath $opencodeDir
    try {
      if ($Version -ne "") {
        $env:OPENCODE_VERSION = $Version
        Write-Host "OPENCODE_VERSION=$Version"
      }
      bun install
      if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
      bun run build -- --single
      if ($LASTEXITCODE -ne 0) { throw "build failed" }
    } finally {
      Pop-Location
    }
  }
} else {
  Write-Host "`n=== Skipping pull/build (-SkipBuild); using existing dist ===" -ForegroundColor Cyan
}

$platformDir = Get-ChildItem -LiteralPath $distDir -Directory -Filter "alphacode-*" |
  Select-Object -First 1
if (-not $platformDir) {
  throw "No alphacode-* platform directory found in $distDir"
}
$candidate = Join-Path $platformDir.FullName "bin/alphacode.exe"
if (-not (Test-Path -LiteralPath $candidate)) {
  $candidate = Join-Path $platformDir.FullName "bin/alphacode"
}
if (-not (Test-Path -LiteralPath $candidate)) {
  throw "Built binary not found under $($platformDir.FullName)/bin"
}
Write-Host "Built: $candidate (platform dir: $($platformDir.Name))"

Invoke-Step "Reinstall globally" {
  if (-not (Test-Path -LiteralPath $destDir)) {
    New-Item -ItemType Directory -Path $destDir | Out-Null
  }
  # Drop a stale backup from an older run; best effort, never fatal.
  Remove-Item -LiteralPath $destOld -Force -ErrorAction SilentlyContinue

  $swapped = $false
  if ((Test-Path -LiteralPath $destExe) -and -not $KillRunning) {
    # Renaming a running image is allowed on Windows; only writing to it is
    # locked. Swap aside so a live TUI session is never killed.
    try {
      Rename-Item -LiteralPath $destExe -NewName "alphacode.exe.old" -ErrorAction Stop
      $swapped = $true
      Write-Host "Swapped running binary aside (no session killed)."
    } catch {
      throw "Cannot swap $destExe aside (still locked?). Close the TUI session and rerun, or pass -KillRunning."
    }
  }

  if ($KillRunning) {
    for ($round = 1; $round -le 3; $round++) {
      $running = @(Get-Process -Name "alphacode" -ErrorAction SilentlyContinue)
      if ($running.Count -eq 0) { break }
      Write-Host "Stopping $($running.Count) running alphacode process(es) (round $round)..." -ForegroundColor Yellow
      $running | Stop-Process -Force
      Start-Sleep -Seconds 2
    }
    $leftover = @(Get-Process -Name "alphacode" -ErrorAction SilentlyContinue)
    if ($leftover.Count -gt 0) {
      throw "Could not stop alphacode (PIDs $($leftover.Id -join ',')). Close it manually and rerun."
    }
  }

  # Copy with retries: AV scanners and lazy closes can hold the new file
  # briefly even after the old one is gone.
  $copied = $false
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
      Copy-Item -LiteralPath $candidate -Destination $destExe -Force -ErrorAction Stop
      $copied = $true
      break
    } catch {
      if ($attempt -eq 10) { break }
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $copied) {
    if ($swapped) {
      Rename-Item -LiteralPath $destOld -NewName "alphacode.exe" -ErrorAction SilentlyContinue
      Write-Host "Restored previous binary after copy failure." -ForegroundColor Yellow
    }
    throw "Copy to $destExe kept failing (file lock?). Close the TUI session and rerun, or pass -KillRunning."
  }
  Write-Host "Installed: $destExe"
}

Invoke-Step "Smoke test" {
  $reported = (& $destExe --version).Trim()
  Write-Host "alphacode --version => $reported"
  if ($Version -ne "" -and ($reported -notlike "*$Version*")) {
    throw "Version mismatch: expected '$Version' in '$reported'"
  }
}

if (-not $KeepDist) {
  Invoke-Step "Clean dist" {
    Remove-Item -LiteralPath $distDir -Recurse -Force
  }
}

Write-Host "`nDone. Restart any running alphacode session to pick up the new binary." -ForegroundColor Green
