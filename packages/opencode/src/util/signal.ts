export function signal() {
  let resolve: () => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    trigger() {
      return resolve()
    },
    // Ends the wait with a failure instead of a trigger, for a waiter that can be cut short
    // by something going wrong rather than by the event it is waiting for.
    fail(reason?: unknown) {
      return reject(reason)
    },
    wait() {
      return promise
    },
  }
}
