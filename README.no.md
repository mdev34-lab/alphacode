<p align="center">
  <a href="https://github.com/mdev34-lab/alphacode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="alphacode logo">
    </picture>
  </a>
</p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
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

### Installasjon

> [!NOTE]
> **This is the alphacode fork** — it is not published to any package registry; the only supported install is building from source. (Looking for the published [opencode](https://github.com/anomalyco/opencode) project this fork tracks? Use its own install channels.)

```bash
git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
# binary: ./packages/opencode/dist/opencode-<platform>/bin/opencode (e.g. linux-x64, darwin-arm64)
```

> **Note:** the executable is still named `opencode` for compatibility — this rebrand does not rename the CLI binary, package names, or config paths (`~/.opencode`) at this stage.

### Desktop App (BETA)

> Desktop builds of this fork are not yet published — see `packages/desktop` to build from source.

### Agents

alphacode har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Les mer om [agents](https://github.com/mdev34-lab/alphacode).

### Dokumentasjon

For mer info om hvordan du konfigurerer alphacode, [**se dokumentasjonen**](https://github.com/mdev34-lab/alphacode).

### Bidra

Hvis du vil bidra til alphacode, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på alphacode

Hvis du jobber med et prosjekt som er relatert til alphacode og bruker "alphacode" som en del av navnet; for eksempel "alphacode-dashboard" eller "alphacode-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av alphacode-teamet og ikke er tilknyttet oss på noen måte.

---

**Bli med i fellesskapet** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
