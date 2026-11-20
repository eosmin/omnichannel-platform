import { workerRoleVerdict, WorkerRoleVerdicts } from './worker-role.policy'

describe('workerRoleVerdict', () => {
  it.each([
    [false, false, WorkerRoleVerdicts.OK],
    [false, true, WorkerRoleVerdicts.OK],
    [true, false, WorkerRoleVerdicts.WARN],
    [true, true, WorkerRoleVerdicts.FAIL],
    [undefined, false, WorkerRoleVerdicts.WARN],
    [undefined, true, WorkerRoleVerdicts.FAIL]
  ])('bypass %s, context on %s -> %s', (bypassesRls, contextOn, expected) => {
    expect(workerRoleVerdict({ bypassesRls, contextOn })).toBe(expected)
  })
})
