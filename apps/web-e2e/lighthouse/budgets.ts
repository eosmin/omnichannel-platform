// The budgets of TDD_08 §4.4 that a lab run can measure. Interaction to Next Paint needs a person
// to interact, so Total Blocking Time stands in for it (200 ms is the "good" limit of web.dev).
export const Budgets = {
  FIRST_CONTENTFUL_PAINT_MS: 1_500,
  LARGEST_CONTENTFUL_PAINT_MS: 2_500,
  TIME_TO_INTERACTIVE_MS: 3_500,
  TOTAL_BLOCKING_TIME_MS: 200,
  CUMULATIVE_LAYOUT_SHIFT: 0.1
} as const

// The app is over the script budget today (framework, providers and the inbox shell weigh more than
// 200 KB of JavaScript, compressed as it travels), so each page is held at its ceiling of Step 3.2
// plus a margin: a regression still fails. Lower the ceilings as the bundle is split (Step 7.7); the
// goal is the 200 KB of TDD_08 §4.4.
export const ScriptCeilingsKb = {
  LOGIN: 260,
  INBOX: 340
} as const

// Shared load and CPU noise of a runner: the median of a few runs is what the budget is asserted on
export const RUNS_PER_PAGE = 3
