const { parentPort, workerData } = require('node:worker_threads')
// A count that cannot be one: the thread is not trusted with the log, and the count falls back to none
parentPort.postMessage({
  kind: 'sanitized',
  body: new Uint8Array(workerData.input),
  keptParts: -4.5
})
