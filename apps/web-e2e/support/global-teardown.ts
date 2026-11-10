import { addressesOverTheLinkBudget } from './link-budget'

// Fails the run when an address asked for more magic links than the api lets through in a minute: the suite
// would be waiting for the clock, which makes it slower with no test failing. Give that spec another person
// (`personOf('<role>', import.meta.url, <next slot>)`).
export default function globalTeardown(): void {
  const over = addressesOverTheLinkBudget()
  if (over.length > 0) {
    throw new Error(`Magic links over the budget of an address:\n${over.join('\n')}`)
  }
}
