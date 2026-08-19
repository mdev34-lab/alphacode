<p align="center">
  <a href="https://github.com/mdev34-lab/alphacode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="alphacode logo">
    </picture>
  </a>
</p>
<p align="center">Der Open-Source KI-Coding-Agent.</p>
<p align="center">
  <a href="https://github.com/mdev34-lab/alphacode"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://github.com/mdev34-lab/alphacode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/mdev34-lab/alphacode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![alphacode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/mdev34-lab/alphacode)

---

### Installation
```bash
# From source (requires bun)
git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
```

> [!TIP]
> Entferne Versionen älter als 0.1.x vor der Installation.

### Desktop-App (BETA)

alphacode ist auch als Desktop-Anwendung verfügbar. Lade sie direkt von der [Releases-Seite](https://github.com/mdev34-lab/alphacode/releases) oder [GitHub](https://github.com/mdev34-lab/alphacode) herunter.

| Plattform             | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` oder AppImage       |
```bash
# Desktop packages for this fork are not yet published - build from `packages/desktop`
```

#### Installationsverzeichnis

Das Installationsskript beachtet die folgende Prioritätsreihenfolge für den Installationspfad:

1. `$ALPHACODE_INSTALL_DIR` - Benutzerdefiniertes Installationsverzeichnis
2. `$XDG_BIN_DIR` - XDG Base Directory Specification-konformer Pfad
3. `$HOME/bin` - Standard-Binärverzeichnis des Users (falls vorhanden oder erstellbar)
4. `$HOME/.alphacode/bin` - Standard-Fallback
```bash
# Beispiele
ALPHACODE_INSTALL_DIR=/usr/local/bin git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
XDG_BIN_DIR=$HOME/.local/bin git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
```

### Agents

alphacode enthält zwei eingebaute Agents, zwischen denen du mit der `Tab`-Taste wechseln kannst.

- **build** - Standard-Agent mit vollem Zugriff für Entwicklungsarbeit
- **plan** - Nur-Lese-Agent für Analyse und Code-Exploration
  - Verweigert Datei-Edits standardmäßig
  - Fragt vor dem Ausführen von bash-Befehlen nach
  - Ideal zum Erkunden unbekannter Codebases oder zum Planen von Änderungen

Außerdem ist ein **general**-Subagent für komplexe Suchen und mehrstufige Aufgaben enthalten.
Dieser wird intern genutzt und kann in Nachrichten mit `@general` aufgerufen werden.

Mehr dazu unter [Agents](https://github.com/mdev34-lab/alphacode).

### Dokumentation

Mehr Infos zur Konfiguration von alphacode findest du in unseren [**Docs**](https://github.com/mdev34-lab/alphacode).

### Beitragen

Wenn du zu alphacode beitragen möchtest, lies bitte unsere [Contributing Docs](./CONTRIBUTING.md), bevor du einen Pull Request einreichst.

### Auf alphacode aufbauen

Wenn du an einem Projekt arbeitest, das mit alphacode zusammenhängt und "alphacode" als Teil seines Namens verwendet (z.B. "alphacode-dashboard" oder "alphacode-mobile"), füge bitte einen Hinweis in deine README ein, dass es nicht vom alphacode-Team gebaut wird und nicht in irgendeiner Weise mit uns verbunden ist.

---

**Tritt unserer Community bei** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
