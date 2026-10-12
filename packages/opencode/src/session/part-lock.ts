import { Effect } from "effect"

// The lock spans inline PartUpdated publication. A listener must not write
// the same part inline: acquiring this non-reentrant lock would deadlock.
export function makePartLock() {
  const tails = new Map<string, Promise<void>>()
  const withLock = <A, E, R>(partID: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = tails.get(partID) ?? Promise.resolve()
        let release!: () => void
        const owned = new Promise<void>((done) => {
          release = done
        })
        const tail = previous.then(() => owned)
        tails.set(partID, tail)
        // Even a cancelled waiter remains chained to its predecessor. It can
        // release its own promise early, but cannot release a later waiter
        // until the active predecessor has finished. Only the current tail
        // may delete the key, never an older owner or a cancelled waiter.
        void tail.then(() => {
          if (tails.get(partID) === tail) tails.delete(partID)
        })
        return { previous, release }
      }),
      ({ previous }) => Effect.promise(() => previous).pipe(Effect.andThen(effect)),
      ({ release }) => Effect.sync(release),
    )
  return { withLock, size: () => tails.size }
}
