<p align="center">
  <a href="https://github.com/mdev34-lab/alphacode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo alphacode">
    </picture>
  </a>
</p>
<p align="center">L'agent de codage IA open source.</p>
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

> [!NOTE]
> **This is the alphacode fork** — it is not published to any package registry; the only supported install is building from source. (Looking for the published [opencode](https://github.com/anomalyco/opencode) project this fork tracks? Use its own install channels.)

```bash
git clone https://github.com/mdev34-lab/alphacode.git
cd alphacode
bun install
./packages/opencode/script/build.ts --single
# binary: ./packages/opencode/dist/opencode-<platform>/bin/opencode (e.g. linux-x64, darwin-arm64)
```

### Desktop App (BETA)

> Desktop builds of this fork are not yet published — see `packages/desktop` to build from source.

### Agents

alphacode inclut deux agents intégrés que vous pouvez basculer avec la touche `Tab`.

- **build** - Par défaut, agent avec accès complet pour le travail de développement
- **plan** - Agent en lecture seule pour l'analyse et l'exploration du code
  - Refuse les modifications de fichiers par défaut
  - Demande l'autorisation avant d'exécuter des commandes bash
  - Idéal pour explorer une base de code inconnue ou planifier des changements

Un sous-agent **general** est aussi inclus pour les recherches complexes et les tâches en plusieurs étapes.
Il est utilisé en interne et peut être invoqué via `@general` dans les messages.

En savoir plus sur les [agents](https://github.com/mdev34-lab/alphacode).

### Documentation

Pour plus d'informations sur la configuration d'alphacode, [**consultez notre documentation**](https://github.com/mdev34-lab/alphacode).

### Contribuer

Si vous souhaitez contribuer à alphacode, lisez nos [docs de contribution](./CONTRIBUTING.md) avant de soumettre une pull request.

### Construire avec alphacode

Si vous travaillez sur un projet lié à alphacode et que vous utilisez "alphacode" dans le nom du projet (par exemple, "alphacode-dashboard" ou "alphacode-mobile"), ajoutez une note dans votre README pour préciser qu'il n'est pas construit par l'équipe alphacode et qu'il n'est pas affilié à nous.

---

**Rejoignez notre communauté** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
