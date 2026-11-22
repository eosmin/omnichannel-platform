const { parentPort } = require('node:worker_threads')
// Begins as a zip and has no end record
parentPort.postMessage({
  kind: 'sanitized',
  body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
})
