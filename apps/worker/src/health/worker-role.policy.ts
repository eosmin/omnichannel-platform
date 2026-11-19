export const WorkerRoleVerdicts = {
  OK: 'ok',
  WARN: 'warn',
  FAIL: 'fail'
} as const
export type WorkerRoleVerdict = (typeof WorkerRoleVerdicts)[keyof typeof WorkerRoleVerdicts]

// What the worker does when it learns whether its database role skips row-level security. With WORKER_RLS_CONTEXT on, every job runs in
// a context that assumes the policies bind it: a role that still skips them would hide a missing context behind full results, so the
// start fails. With the flag off a bypassing role is the normal state (and what a rollback leaves), so it only warns: no crash loop.
export function workerRoleVerdict(input: {
  bypassesRls: boolean | undefined
  contextOn: boolean
}): WorkerRoleVerdict {
  // undefined: the role could not be read, which is not the same as safe
  if (input.bypassesRls === false) return WorkerRoleVerdicts.OK
  return input.contextOn ? WorkerRoleVerdicts.FAIL : WorkerRoleVerdicts.WARN
}
