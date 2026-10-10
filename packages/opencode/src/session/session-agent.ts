import { Effect } from "effect"
import type { Session } from "./session"
import { NotFoundError } from "@/storage/storage"

/** Pinned session owner, then newest user. The running tool agent is not a fallback. */
export const sessionAgent = (sessions: Session.Interface, session: Session.Info) =>
  Effect.gen(function* () {
    if (session.agent) return session.agent
    const messages = yield* sessions
      .messages({ sessionID: session.id, limit: 50 })
      .pipe(
        Effect.catchIf(NotFoundError.isInstance, (cause) =>
          Effect.fail(
            new Error(
              `Cannot resolve which reviewer to dispatch: parent session ${session.id} could not be read (${cause.message})`,
            ),
          ),
        ),
      )
    return messages.findLast((message) => message.info.role === "user")?.info.agent
  })
