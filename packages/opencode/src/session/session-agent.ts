import { Effect } from "effect"
import type { Session } from "./session"
import { NotFoundError } from "@/storage/storage"

/** Rows of the newest-first page both routing readers consult. */
export const ROUTING_WINDOW = 50

/**
 * The routing rule itself, shared by every reader: the pinned session owner,
 * then the newest user message of an ascending window. Callers own how the
 * window is read (task pages it from storage; finish slices history it already
 * holds), so read-failure behavior stays with each caller.
 */
export const routedAgent = (
  session: Pick<Session.Info, "agent">,
  window: readonly { info: { role: string; agent?: string } }[],
) => session.agent ?? window.findLast((message) => message.info.role === "user")?.info.agent

/** Pinned session owner, then newest user. The running tool agent is not a fallback. */
export const sessionAgent = (sessions: Session.Interface, session: Session.Info) =>
  Effect.gen(function* () {
    if (session.agent) return session.agent
    const messages = yield* sessions
      .messages({ sessionID: session.id, limit: ROUTING_WINDOW })
      .pipe(
        Effect.catchIf(NotFoundError.isInstance, (cause) =>
          Effect.fail(
            new Error(
              `Cannot resolve which reviewer to dispatch: parent session ${session.id} could not be read (${cause.message})`,
            ),
          ),
        ),
      )
    return routedAgent(session, messages)
  })
