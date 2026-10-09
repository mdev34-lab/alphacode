import { createContext, createSignal, useContext, type Accessor, type ParentProps, type Setter } from "solid-js"
import { displayWidth, truncateDisplay } from "../../prompt/display"

type Context = {
  tips: Accessor<string[] | undefined>
  setTips: Setter<string[] | undefined>
}

const HomeTipPlaceholderContext = createContext<Context>()

/** Pick a rotating tip and fit it to the available terminal columns. */
export function fitHomeTipPlaceholder(tips: string[] | undefined, width: number, offset: number, step: number) {
  if (!tips?.length) return undefined

  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const fitting = tips.filter((item) => displayWidth(item) <= columns)
  const pool = fitting.length ? fitting : tips
  const value = pool[Math.floor(offset * pool.length + step) % pool.length]
  if (value === undefined) return undefined
  return truncateDisplay(value, columns)
}

/**
 * Lets the home tips plugin publish plain-text tips for the prompt placeholder.
 * `undefined` means no tips are visible, so the prompt keeps its example placeholder.
 */
export function HomeTipPlaceholderProvider(props: ParentProps) {
  const [tips, setTips] = createSignal<string[]>()
  return (
    <HomeTipPlaceholderContext.Provider value={{ tips, setTips }}>{props.children}</HomeTipPlaceholderContext.Provider>
  )
}

export function useHomeTipPlaceholder() {
  return useContext(HomeTipPlaceholderContext)
}
