/**
 * The background subagents a headless run launched, as the run's event stream
 * describes them.
 *
 * The run must not exit while work it started is still in flight: exiting tears
 * down the in-process server and every job with it. Tracking launches alone is
 * not enough. A subagent that yields for its own subagents ends its turn while
 * they keep running (#222), and it goes idle again between the turns it resumes
 * for, so an idle session is not a finished one. Sessions are therefore tracked
 * from the task parts that launched them - a launch inside a child session is
 * known to belong to that child - and a session is open while it is neither
 * idle nor resolved, or while anything it launched is still open.
 *
 * A terminal envelope resolves a session on its own: a child may legitimately
 * finish while a subagent of its own still runs, and that subagent still has to
 * settle before the run may end. A launch whose parent is neither the run's
 * session nor a tracked one belongs to another session in the same instance and
 * is ignored.
 */
export const make = (rootSessionID: string) => {
  const launched = new Map<string, { parent: string }>()
  const idle = new Set<string>()
  const resolved = new Set<string>()

  const children = (sessionID: string) =>
    [...launched.keys()].filter((id) => launched.get(id)?.parent === sessionID)

  const open = (sessionID: string): boolean => {
    if (!launched.has(sessionID)) return false
    if (!idle.has(sessionID) && !resolved.has(sessionID)) return true
    return children(sessionID).some(open)
  }

  const known = (sessionID: string) => sessionID === rootSessionID || launched.has(sessionID)

  return {
    /** A task part launched a background child from `parentSessionID`. */
    launch(input: { sessionID: string; parentSessionID: string }) {
      if (launched.has(input.sessionID) || resolved.has(input.sessionID)) return false
      if (!known(input.parentSessionID)) return false
      launched.set(input.sessionID, { parent: input.parentSessionID })
      return true
    },
    /**
     * The session reported a terminal result. Recorded for sessions this run
     * has not seen a launch part for yet: a fast completion can be reported
     * before its own task part arrives.
     */
    resolve(sessionID: string) {
      resolved.add(sessionID)
    },
    /** The session's status changed: a resumed turn makes it busy again. */
    status(sessionID: string, status: string) {
      if (!launched.has(sessionID)) return
      if (status === "idle") idle.add(sessionID)
      if (status === "busy") idle.delete(sessionID)
    },
    /** Every tracked session still running, in launch order. */
    pending() {
      return [...launched.keys()].filter((id) => !idle.has(id) && !resolved.has(id))
    },
    /** No tracked session is still in flight. */
    settled() {
      return ![...launched.keys()].some(open)
    },
  }
}

export * as BackgroundTasks from "./background-tasks"
