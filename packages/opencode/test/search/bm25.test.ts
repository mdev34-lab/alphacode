import { describe, test, expect } from "bun:test"
import { BM25 } from "@/search/bm25"

describe("BM25", () => {
  describe("tokenize", () => {
    test("lowercases text", () => {
      expect(BM25.tokenize("Hello World")).toEqual(["hello", "world"])
    })

    test("removes punctuation", () => {
      expect(BM25.tokenize("hello, world!")).toEqual(["hello", "world"])
    })

    test("handles multiple spaces", () => {
      expect(BM25.tokenize("hello   world")).toEqual(["hello", "world"])
    })

    test("filters empty strings", () => {
      expect(BM25.tokenize("  hello  ")).toEqual(["hello"])
    })

    test("keeps numbers", () => {
      expect(BM25.tokenize("file123 test")).toEqual(["file123", "test"])
    })
    test("keeps non-ascii letters and digits", () => {
      expect(BM25.tokenize("Edição de Conteúdo")).toEqual(["edição", "de", "conteúdo"])
      expect(BM25.tokenize("Añadir imágenes")).toEqual(["añadir", "imágenes"])
      expect(BM25.tokenize("Дерево файлов")).toEqual(["дерево", "файлов"])
    })

    test("still strips punctuation around non-ascii words", () => {
      expect(BM25.tokenize("gestão, de arquivos!")).toEqual(["gestão", "de", "arquivos"])
    })
  })

  describe("fold", () => {
    test("folds regular plurals to their singular form", () => {
      expect(BM25.fold("errors")).toBe("error")
      expect(BM25.fold("issues")).toBe("issue")
      expect(BM25.fold("matches")).toBe("match")
    })

    // What matters for retrieval is that both spellings land on the same term, not that the
    // term is the dictionary singular.
    test("plural and singular agree for -y and -ie words", () => {
      for (const [plural, singular] of [
        ["repositories", "repository"],
        ["queries", "query"],
        ["policies", "policy"],
        ["categories", "category"],
        ["dependencies", "dependency"],
        ["identities", "identity"],
        ["utilities", "utility"],
        ["services", "service"],
        ["cookies", "cookie"],
        ["movies", "movie"],
        ["directories", "directory"],
        ["keys", "key"],
      ]) {
        expect(BM25.fold(plural)).toBe(BM25.fold(singular))
      }
    })

    // Collapsing y/ie/ies onto i is agreement folding, not linguistics: it can in principle
    // merge unrelated words, so the pairs that share a prefix are pinned here.
    test("does not collide unrelated words while folding y", () => {
      for (const [a, b] of [
        ["cookies", "cook"],
        ["policies", "police"],
        ["queries", "queue"],
        ["directories", "direct"],
        ["identities", "identify"],
        ["copies", "cope"],
        ["dependencies", "depend"],
        ["libraries", "librarian"],
        ["histories", "host"],
        ["registry", "register"],
      ]) {
        expect(BM25.fold(a)).not.toBe(BM25.fold(b))
      }
    })

    test("leaves short words and non-plurals alone", () => {
      expect(BM25.fold("ls")).toBe("ls")
      expect(BM25.fold("css")).toBe("css")
      expect(BM25.fold("status")).toBe("status")
      expect(BM25.fold("read")).toBe("read")
    })

    test("does not mangle singular words that end in s", () => {
      for (const word of [
        "alias",
        "atlas",
        "canvas",
        "bias",
        "chaos",
        "lens",
        "news",
        "series",
        "species",
        "analysis",
        "basis",
        "address",
        "process",
        "class",
        "bus",
        "gas",
        "https",
        "dns",
      ]) {
        expect(BM25.fold(word)).toBe(word)
      }
    })

    test("does not truncate technical words that end in ss", () => {
      for (const word of [
        "access",
        "address",
        "success",
        "business",
        "class",
        "express",
        "process",
        "progress",
        "compress",
        "loss",
        "pass",
        "cross",
      ]) {
        expect(BM25.fold(word)).toBe(word)
      }
    })

    test("folds the plurals of ss words back onto the singular", () => {
      expect(BM25.fold("accesses")).toBe("access")
      expect(BM25.fold("addresses")).toBe("address")
      expect(BM25.fold("successes")).toBe("success")
      expect(BM25.fold("businesses")).toBe("business")
      expect(BM25.fold("classes")).toBe("class")
      expect(BM25.fold("processes")).toBe("process")
    })

    test("folds the plural of those words back onto them", () => {
      expect(BM25.fold("aliases")).toBe("alias")
      expect(BM25.fold("canvases")).toBe("canvas")
      expect(BM25.fold("addresses")).toBe("address")
      expect(BM25.fold("processes")).toBe("process")
      expect(BM25.fold("classes")).toBe("class")
      expect(BM25.fold("buses")).toBe("bus")
    })

    test("folds latin -is plurals onto their singular", () => {
      expect(BM25.fold("analyses")).toBe("analysis")
      expect(BM25.fold("diagnoses")).toBe("diagnosis")
      expect(BM25.fold("hypotheses")).toBe("hypothesis")
      expect(BM25.fold("parentheses")).toBe("parenthesis")
      expect(BM25.fold("crises")).toBe("crisis")
    })

    test("the reviewer battery: plural query and singular document agree", () => {
      for (const [plural, singular] of [
        ["aliases", "alias"],
        ["analyses", "analysis"],
        ["statuses", "status"],
        ["classes", "class"],
        ["processes", "process"],
      ]) {
        expect(BM25.fold(plural)).toBe(BM25.fold(singular))
      }
    })

    test("still folds ordinary plurals that end in as or es", () => {
      expect(BM25.fold("schemas")).toBe("schema")
      expect(BM25.fold("databases")).toBe("database")
      expect(BM25.fold("areas")).toBe("area")
      expect(BM25.fold("boxes")).toBe("box")
      expect(BM25.fold("branches")).toBe("branch")
    })

    test("is idempotent", () => {
      for (const word of ["issues", "repositories", "matches", "alias", "schemas", "status", "files", "cookies"]) {
        expect(BM25.fold(BM25.fold(word))).toBe(BM25.fold(word))
      }
    })
  })

  describe("plural and singular queries", () => {
    test("a plural query matches a singular document and vice versa", () => {
      const docs = [
        { id: "sentry", text: "List error events reported to Sentry for a project" },
        { id: "glob", text: "Find files by name pattern" },
      ]
      const index = BM25.createIndex(docs, (doc) => [doc.id, doc.text])

      expect(BM25.search(index, "errors")[0]?.item.id).toBe("sentry")
      expect(BM25.search(index, "file")[0]?.item.id).toBe("glob")
    })
  })

  describe("createIndex", () => {
    test("creates empty index", () => {
      const index = BM25.createIndex([], () => [])
      expect(index.documentCount).toBe(0)
      expect(index.averageDocumentLength).toBe(0)
    })

    test("indexes single document", () => {
      const items = [{ text: "hello world" }]
      const index = BM25.createIndex(items, (item) => [item.text])

      expect(index.documentCount).toBe(1)
      expect(index.averageDocumentLength).toBe(2)
      expect(index.documentFrequency.get("hello")).toBe(1)
      expect(index.documentFrequency.get("world")).toBe(1)
    })

    test("calculates document frequency across documents", () => {
      const items = [{ text: "hello world" }, { text: "hello there" }, { text: "goodbye world" }]
      const index = BM25.createIndex(items, (item) => [item.text])

      expect(index.documentCount).toBe(3)
      expect(index.documentFrequency.get("hello")).toBe(2)
      expect(index.documentFrequency.get("world")).toBe(2)
      expect(index.documentFrequency.get("there")).toBe(1)
      expect(index.documentFrequency.get("goodbye")).toBe(1)
    })

    test("handles multiple fields", () => {
      const items = [{ name: "file", description: "a test file" }]
      const index = BM25.createIndex(items, (item) => [item.name, item.description])

      expect(index.documents[0].length).toBe(4) // file, a, test, file
      expect(index.documents[0].termFrequency.get("file")).toBe(2)
    })
  })

  describe("search", () => {
    test("returns empty for empty index", () => {
      const index = BM25.createIndex([], () => [])
      const results = BM25.search(index, "hello")
      expect(results).toEqual([])
    })

    test("returns empty for empty query", () => {
      const items = [{ text: "hello world" }]
      const index = BM25.createIndex(items, (item) => [item.text])
      const results = BM25.search(index, "   ")
      expect(results).toEqual([])
    })

    test("finds exact match", () => {
      const items = [
        { id: 1, text: "hello world" },
        { id: 2, text: "goodbye moon" },
      ]
      const index = BM25.createIndex(items, (item) => [item.text])
      const results = BM25.search(index, "hello")

      expect(results.length).toBe(1)
      expect(results[0].item.id).toBe(1)
      expect(results[0].score).toBeGreaterThan(0)
    })

    test("ranks by relevance", () => {
      const items = [
        { id: 1, text: "the cat sat on the mat" },
        { id: 2, text: "cat cat cat" },
        { id: 3, text: "dog dog dog" },
      ]
      const index = BM25.createIndex(items, (item) => [item.text])
      const results = BM25.search(index, "cat")

      expect(results.length).toBe(2)
      // Document with more "cat" occurrences should rank higher
      expect(results[0].item.id).toBe(2)
      expect(results[1].item.id).toBe(1)
    })

    test("handles multi-word queries", () => {
      const items = [
        { id: 1, text: "search for files" },
        { id: 2, text: "find files in directory" },
        { id: 3, text: "search for patterns" },
      ]
      const index = BM25.createIndex(items, (item) => [item.text])
      const results = BM25.search(index, "search files")

      expect(results.length).toBe(3)
      // Document matching both terms should rank highest
      expect(results[0].item.id).toBe(1)
    })

    test("respects limit parameter", () => {
      const items = [
        { id: 1, text: "hello" },
        { id: 2, text: "hello" },
        { id: 3, text: "hello" },
      ]
      const index = BM25.createIndex(items, (item) => [item.text])
      const results = BM25.search(index, "hello", 2)

      expect(results.length).toBe(2)
    })

    test("excludes documents with zero score", () => {
      const items = [
        { id: 1, text: "hello world" },
        { id: 2, text: "foo bar" },
      ]
      const index = BM25.createIndex(items, (item) => [item.text])
      const results = BM25.search(index, "hello")

      expect(results.length).toBe(1)
      expect(results[0].item.id).toBe(1)
    })
  })

  describe("IDF weighting", () => {
    test("rare terms score higher than common terms", () => {
      const items = [
        { id: 1, text: "unique rare term" },
        { id: 2, text: "common term" },
        { id: 3, text: "common term" },
        { id: 4, text: "common term" },
      ]
      const index = BM25.createIndex(items, (item) => [item.text])

      const rareResults = BM25.search(index, "rare")
      const commonResults = BM25.search(index, "common")

      // Rare term should have higher IDF, thus higher score per occurrence
      expect(rareResults[0].score).toBeGreaterThan(commonResults[0].score)
    })
  })

  describe("document length normalization", () => {
    test("shorter documents with same term frequency score higher", () => {
      const items = [
        { id: 1, text: "cat" },
        { id: 2, text: "cat and many other words that make this document longer" },
      ]
      const index = BM25.createIndex(items, (item) => [item.text])
      const results = BM25.search(index, "cat")

      expect(results.length).toBe(2)
      expect(results[0].item.id).toBe(1)
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })
  })

  describe("addItem", () => {
    test("adds item to existing index", () => {
      const items = [{ text: "hello world" }]
      const index = BM25.createIndex(items, (item) => [item.text])

      expect(index.documentCount).toBe(1)

      BM25.addItem(index, { text: "goodbye moon" }, (item) => [item.text])

      expect(index.documentCount).toBe(2)
      expect(index.documentFrequency.get("goodbye")).toBe(1)
    })

    test("updates average document length", () => {
      const items = [{ text: "a b" }] // length 2
      const index = BM25.createIndex(items, (item) => [item.text])

      expect(index.averageDocumentLength).toBe(2)

      BM25.addItem(index, { text: "c d e f" }, (item) => [item.text]) // length 4

      expect(index.averageDocumentLength).toBe(3) // (2 + 4) / 2
    })

    test("makes new item searchable", () => {
      const items = [{ id: 1, text: "hello world" }]
      const index = BM25.createIndex(items, (item) => [item.text])

      BM25.addItem(index, { id: 2, text: "unique term" }, (item) => [item.text])

      const results = BM25.search(index, "unique")
      expect(results.length).toBe(1)
      expect(results[0].item.id).toBe(2)
    })
  })

  describe("getStats", () => {
    test("returns correct statistics", () => {
      const items = [{ text: "hello world" }, { text: "hello there friend" }]
      const index = BM25.createIndex(items, (item) => [item.text])
      const stats = BM25.getStats(index)

      expect(stats.documentCount).toBe(2)
      expect(stats.uniqueTerms).toBe(4) // hello, world, there, friend
      expect(stats.averageDocumentLength).toBe(2.5) // (2 + 3) / 2
      expect(stats.config.k1).toBe(0.9)
      expect(stats.config.b).toBe(0.4)
    })
  })

  describe("custom config", () => {
    test("respects custom k1 and b parameters", () => {
      const items = [{ text: "hello world" }]
      const index = BM25.createIndex(items, (item) => [item.text], { k1: 2.0, b: 0.5 })

      expect(index.config.k1).toBe(2.0)
      expect(index.config.b).toBe(0.5)
    })
  })

  describe("real-world tool search scenario", () => {
    test("finds relevant tools by description", () => {
      const tools = [
        { id: "read_file", name: "Read", description: "Read contents of a file from the filesystem" },
        { id: "write_file", name: "Write", description: "Write contents to a file on the filesystem" },
        { id: "search_code", name: "Grep", description: "Search for patterns in code using regex" },
        { id: "list_files", name: "Glob", description: "List files matching a glob pattern" },
        { id: "run_command", name: "Bash", description: "Execute shell commands in the terminal" },
      ]

      const index = BM25.createIndex(tools, (tool) => [tool.name, tool.description])

      // Search for file operations
      const fileResults = BM25.search(index, "file")
      expect(fileResults.length).toBeGreaterThan(0)
      expect(fileResults.map((r) => r.item.id)).toContain("read_file")
      expect(fileResults.map((r) => r.item.id)).toContain("write_file")

      // Search for search functionality
      const searchResults = BM25.search(index, "search regex")
      expect(searchResults[0].item.id).toBe("search_code")

      // Search for shell/command
      const shellResults = BM25.search(index, "shell command")
      expect(shellResults[0].item.id).toBe("run_command")
    })
  })
})
