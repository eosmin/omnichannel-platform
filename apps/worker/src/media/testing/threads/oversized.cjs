const { parentPort, workerData } = require('node:worker_threads')
// A result bigger than the limit the caller gave
parentPort.postMessage({ kind: 'sanitized', body: new Uint8Array(workerData.maxBytes + 1) })
