// Throwaway branch only: proves a red shard turns the security-tests check red. Never merged.
describe('a shard that fails on purpose', () => {
  it('fails', () => {
    expect(1).toBe(2)
  })
})
