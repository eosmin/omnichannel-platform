const { parentPort, workerData } = require('node:worker_threads')
// Echoes what it received as a cleaned document, and reports what the thread can see of the process
parentPort.postMessage({ kind: 'sanitized', body: new Uint8Array(workerData.input) })
