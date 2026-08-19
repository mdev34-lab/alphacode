<p align="center">
  <a href="https://github.com/mdev34-lab/alphacode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="alphacode logo">
    </picture>
  </a>
</p>
<p align="center">AI-агент для програмування з відкритим кодом.</p>
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

### Встановлення
```bash
# From source (requires bun)
git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
```

> [!TIP]
> Перед встановленням видаліть версії старші за 0.1.x.

### Десктопний застосунок (BETA)

alphacode також доступний як десктопний застосунок. Завантажуйте напряму зі [сторінки релізів](https://github.com/mdev34-lab/alphacode/releases) або [GitHub](https://github.com/mdev34-lab/alphacode).

| Платформа             | Завантаження                       |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` або AppImage        |
```bash
# Desktop packages for this fork are not yet published - build from `packages/desktop`
```

#### Каталог встановлення

Скрипт встановлення дотримується такого порядку пріоритету для шляху встановлення:

1. `$ALPHACODE_INSTALL_DIR` - Користувацький каталог встановлення
2. `$XDG_BIN_DIR` - Шлях, сумісний зі специфікацією XDG Base Directory
3. `$HOME/bin` - Стандартний каталог користувацьких бінарників (якщо існує або його можна створити)
4. `$HOME/.alphacode/bin` - Резервний варіант за замовчуванням
```bash
# Приклади
ALPHACODE_INSTALL_DIR=/usr/local/bin git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
XDG_BIN_DIR=$HOME/.local/bin git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
```

### Агенти

alphacode містить два вбудовані агенти, між якими можна перемикатися клавішею `Tab`.

- **build** - Агент за замовчуванням із повним доступом для завдань розробки
- **plan** - Агент лише для читання для аналізу та дослідження коду
  - За замовчуванням забороняє редагування файлів
  - Запитує дозвіл перед запуском bash-команд
  - Ідеально підходить для дослідження незнайомих кодових баз або планування змін

Також доступний допоміжний агент **general** для складного пошуку та багатокрокових завдань.
Він використовується всередині системи й може бути викликаний у повідомленнях через `@general`.

Дізнайтеся більше про [agents](https://github.com/mdev34-lab/alphacode).

### Документація

Щоб дізнатися більше про налаштування alphacode, [**перейдіть до нашої документації**](https://github.com/mdev34-lab/alphacode).

### Внесок

Якщо ви хочете зробити внесок в alphacode, будь ласка, прочитайте нашу [документацію для контриб'юторів](./CONTRIBUTING.md) перед надсиланням pull request.

### Проєкти на базі alphacode

Якщо ви працюєте над проєктом, пов'язаним з alphacode, і використовуєте "alphacode" у назві, наприклад "alphacode-dashboard" або "alphacode-mobile", додайте примітку до свого README.
Уточніть, що цей проєкт не створений командою alphacode і жодним чином не афілійований із нами.

---

**Приєднуйтеся до нашої спільноти** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
