module.exports = {
  displayName: 'workspace',
  preset: '../jest.preset.cjs',
  // The specs of the helpers in scripts/lib; the scripts themselves are run by the CI jobs
  testMatch: ['<rootDir>/lib/**/*.spec.ts']
}
