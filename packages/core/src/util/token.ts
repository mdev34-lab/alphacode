export * as Token from "./token"

const CHARS_PER_TOKEN = 4

/** Token estimate for a payload whose serialized length is already known. */
export const fromLength = (characters: number) => Math.max(0, Math.round(characters / CHARS_PER_TOKEN))

export const estimate = (input: string) => fromLength(input.length)
