const { parentPort, workerData } = require('node:worker_threads')
// Begins as the type says and ends nowhere: the first bytes of what it was given, cut before the end mark
parentPort.postMessage({ kind: 'sanitized', body: new Uint8Array(workerData.input).slice(0, 12) })
