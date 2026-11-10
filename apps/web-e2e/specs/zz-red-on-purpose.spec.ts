import { expect, test } from '@playwright/test'

// Throwaway branch only: proves a red slice turns the e2e-tests check red. Never merged.
test('fails on purpose', () => {
  expect(1).toBe(2)
})
