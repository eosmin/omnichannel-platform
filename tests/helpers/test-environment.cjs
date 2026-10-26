const NodeEnvironment = require('jest-environment-node').TestEnvironment

// The node environment of Jest, plus one thing: when a test fails, the last answers of the api
// that the test received are printed (tests/helpers/http.ts keeps them in `__recentResponses`).
// A failed `expect(response.status).toBe(409)` says only "Received: 401"; this says which request
// got it and with what error code, so a failure that shows up once in CI can be understood.
class TestEnvironment extends NodeEnvironment {
  handleTestEvent(event) {
    const recent = this.global.__recentResponses
    if (event.name === 'test_start') this.global.__recentResponses = []
    if (event.name === 'test_done' && event.test.errors.length > 0 && recent?.length > 0) {
      const lines = recent.map(
        ({ method, path, status, code }) =>
          `    ${method.toUpperCase()} ${path} -> ${status}${code === undefined ? '' : ` ${code}`}`
      )
      process.stderr.write(
        `\nAnswers of the api in the failed test "${event.test.name}":\n${lines.join('\n')}\n`
      )
    }
  }
}

module.exports = TestEnvironment
