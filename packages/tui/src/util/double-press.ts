/**
 * How long a first press stays armed before it lapses. Shared by the prompt's
 * interrupt and the subagent trace's stop so the two double-press gestures
 * behave identically instead of drifting apart.
 */
export const DOUBLE_PRESS_WINDOW_MS = 5000
