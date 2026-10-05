/**
 * Every agent that reviews completed work and therefore must deliver its result
 * through a `<alphacode-review>` report envelope.
 *
 * The set is the single source of truth for the report gate, which is applied in
 * three places: the finish tool (refuses to complete a run without a parseable
 * envelope), the task tool (extracts the envelope and attaches it to the parent
 * envelope), and the session nudge (applies review stagnation to a reviewer's
 * turns). A review agent missing from this set still completes without a verdict
 * rather than failing loudly, so centralising the list here buys a single edit
 * site and a guard test - it does not remove the failure mode. A new reviewer
 * must be added here rather than compared inline at each gate.
 *
 * `ReviewAgent` is the element type, not `string`, so the routing table below
 * can name the invariant this module documents - every routed target is itself
 * a reviewer - and have the compiler enforce it. The set stays a runtime value
 * because the gate is applied to an agent name read from a session row, which
 * the type system never sees; the pair is pinned together by the guard test
 * rather than by inference from the `Set`.
 */
export const REVIEW_AGENTS: ReadonlySet<ReviewAgent> = new Set<ReviewAgent>(["review", "work-review", "code-review"])

export type ReviewAgent = "review" | "work-review" | "code-review"

/**
 * Answers "is this dispatched name a reviewer", for the report gate. It is not a
 * routing table: nothing here maps one name to another.
 */
export function isReviewAgent(name: string | undefined) {
  return name !== undefined && REVIEW_AGENTS.has(name as ReviewAgent)
}

/**
 * Which reviewer runs a generic `review` request, keyed by the agent that made
 * the request. This is the routing table, and it is deliberately separate from
 * `REVIEW_AGENTS`: a parent with no entry keeps the generic reviewer.
 *
 * The key type is deliberately `string`, not a discriminated union of the two
 * parents that have a specialization. The key domain is the set of agents a user
 * can define in config, which is open-ended, so a union key would make every
 * future configured agent a compile error at this table and force a widening
 * cast at the one call site that indexes it with a resolved parent name. There is
 * no closed parent union to check exhaustiveness against, so `Record<...>` would
 * buy nothing; the guard test in `review-specialization.test.ts` pins the other
 * direction instead, and the `ReviewAgent` value type pins this one at compile
 * time.
 */
export const REVIEW_ROUTING: Readonly<Record<string, ReviewAgent>> = {
  work: "work-review",
  code: "code-review",
}

/**
 * Resolves the agent actually dispatched. Only a generic `review` request is
 * rewritten; every other requested name passes through untouched, so routing can
 * never turn an explicit delegation into a different one.
 */
export function resolveReviewer(requested: string, parentAgent: string | undefined) {
  if (requested !== "review") return requested
  return (parentAgent === undefined ? undefined : REVIEW_ROUTING[parentAgent]) ?? requested
}
