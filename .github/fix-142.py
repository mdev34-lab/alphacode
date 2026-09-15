from pathlib import Path
import re

session = Path('packages/tui/src/routes/session/index.tsx')
text = session.read_text()
old = '''      value: "session.toggle.actions",\n      category: "Session",\n      run: () => {'''
new = '''      value: "session.toggle.actions",\n      category: "Session",\n      slash: {\n        name: "details",\n      },\n      run: () => {'''
assert old in text
text = text.replace(old, new, 1)
old = '''      value: "session.toggle.activity",\n      category: "Session",\n      slash: {\n        name: "activity",\n      },'''
new = '''      value: "session.toggle.activity",\n      category: "Session",\n      slash: {\n        name: "activity",\n        aliases: ["working"],\n      },'''
assert old in text
text = text.replace(old, new, 1)
session.write_text(text)

keymap = Path('packages/tui/src/keymap.tsx')
text = keymap.read_text()
text = re.sub(r'\nconst BUILTIN_SLASH_METADATA: Record<string, \{ name\?: string; aliases\?: string\[\] \}> = \{\n  "session\\.toggle\\.actions": \{ name: "details" \},\n  "session\\.toggle\\.activity": \{ aliases: \["working"\] \},\n\}\n', '\n', text, count=1)
old = '''    entries().flatMap((entry) => {\n      const metadata = BUILTIN_SLASH_METADATA[entry.command.name]\n      const slashName = metadata?.name ?? entry.command.slashName\n      if (typeof slashName !== "string" || !slashName) return []\n      const slashAliases = [\n        ...(Array.isArray(entry.command.slashAliases)\n          ? entry.command.slashAliases.filter((alias): alias is string => typeof alias === "string")\n          : []),\n        ...(metadata?.aliases ?? []),\n      ]'''
new = '''    entries().flatMap((entry) => {\n      const slashName = entry.command.slashName\n      if (typeof slashName !== "string" || !slashName) return []\n      const slashAliases = entry.command.slashAliases'''
assert old in text
text = text.replace(old, new, 1)
old = '''        aliases: slashAliases.length > 0 ? slashAliases.map((alias) => `/${alias}`) : undefined,'''
new = '''        aliases: Array.isArray(slashAliases)\n          ? slashAliases.filter((alias): alias is string => typeof alias === "string").map((alias) => `/${alias}`)\n          : undefined,'''
assert old in text
text = text.replace(old, new, 1)
keymap.write_text(text)
