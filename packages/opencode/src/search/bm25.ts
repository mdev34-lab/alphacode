/**
 * BM25 (Best Matching 25) - a probabilistic ranking function for information retrieval.
 *
 * Documents are scored on query term frequency, inverse document frequency and document
 * length normalization. Used by the tool catalog to rank tools against a natural language
 * query without needing an embedding model.
 */

export interface Config {
  /** Term frequency saturation parameter (typical range: 0.5-2.0) */
  k1: number
  /** Document length normalization parameter (range: 0-1) */
  b: number
}

export interface Document {
  id: string
  /** Pre-tokenized terms for this document */
  terms: string[]
  /** Term frequency map: term -> count */
  termFrequency: Map<string, number>
  /** Document length (number of terms) */
  length: number
}

export interface SearchResult<T> {
  item: T
  score: number
}

export interface Index<T> {
  documents: Document[]
  items: T[]
  /** Document frequency: term -> number of documents containing the term */
  documentFrequency: Map<string, number>
  averageDocumentLength: number
  documentCount: number
  config: Config
}

const DEFAULT_CONFIG: Config = {
  k1: 0.9,
  b: 0.4,
}

/** Tokenize text into normalized terms */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

function buildTermFrequency(terms: string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const term of terms) {
    result.set(term, (result.get(term) ?? 0) + 1)
  }
  return result
}

/**
 * Create a new BM25 index from items.
 *
 * @param items - items to index
 * @param getFields - extracts the searchable text fields from an item
 * @param config - optional BM25 tuning parameters
 */
export function createIndex<T>(items: T[], getFields: (item: T) => string[], config: Partial<Config> = {}): Index<T> {
  const finalConfig: Config = { ...DEFAULT_CONFIG, ...config }
  const documents: Document[] = []
  const documentFrequency = new Map<string, number>()

  for (let i = 0; i < items.length; i++) {
    const terms = getFields(items[i]).flatMap((field) => tokenize(field))
    const termFrequency = buildTermFrequency(terms)

    for (const term of termFrequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }

    documents.push({ id: String(i), terms, termFrequency, length: terms.length })
  }

  const totalLength = documents.reduce((sum, doc) => sum + doc.length, 0)

  return {
    documents,
    items,
    documentFrequency,
    averageDocumentLength: documents.length > 0 ? totalLength / documents.length : 0,
    documentCount: documents.length,
    config: finalConfig,
  }
}

/**
 * Inverse document frequency: log((N - df + 0.5) / (df + 0.5) + 1)
 */
function calculateIDF(documentCount: number, documentFrequency: number): number {
  return Math.log((documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1)
}

function scoreDocument(document: Document, queryTerms: string[], index: Index<unknown>): number {
  const { k1, b } = index.config
  let score = 0

  for (const term of queryTerms) {
    const df = index.documentFrequency.get(term) ?? 0
    if (df === 0) continue

    const tf = document.termFrequency.get(term) ?? 0
    if (tf === 0) continue

    const idf = calculateIDF(index.documentCount, df)
    const numerator = tf * (k1 + 1)
    const denominator = tf + k1 * (1 - b + b * (document.length / index.averageDocumentLength))
    score += idf * (numerator / denominator)
  }

  return score
}

/**
 * Search the index, returning matches sorted by score (highest first).
 */
export function search<T>(index: Index<T>, query: string, limit = 10): SearchResult<T>[] {
  if (index.documentCount === 0) return []

  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const results: SearchResult<T>[] = []
  for (let i = 0; i < index.documents.length; i++) {
    const score = scoreDocument(index.documents[i], queryTerms, index)
    if (score > 0) results.push({ item: index.items[i], score })
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

/**
 * Add a single item to an existing index. Less efficient than rebuilding for bulk additions.
 */
export function addItem<T>(index: Index<T>, item: T, getFields: (item: T) => string[]): void {
  const terms = getFields(item).flatMap((field) => tokenize(field))
  const termFrequency = buildTermFrequency(terms)

  for (const term of termFrequency.keys()) {
    index.documentFrequency.set(term, (index.documentFrequency.get(term) ?? 0) + 1)
  }

  index.documents.push({ id: String(index.documents.length), terms, termFrequency, length: terms.length })
  index.items.push(item)

  const totalLength = index.documents.reduce((sum, doc) => sum + doc.length, 0)
  index.averageDocumentLength = totalLength / index.documents.length
  index.documentCount = index.documents.length
}

/** Index statistics, for debugging and tuning */
export function getStats<T>(index: Index<T>): {
  documentCount: number
  uniqueTerms: number
  averageDocumentLength: number
  config: Config
} {
  return {
    documentCount: index.documentCount,
    uniqueTerms: index.documentFrequency.size,
    averageDocumentLength: index.averageDocumentLength,
    config: index.config,
  }
}

export * as BM25 from "./bm25"
