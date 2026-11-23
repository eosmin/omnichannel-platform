const { parentPort, workerData } = require('node:worker_threads')
// Answers with the document and a count of the parts it left as they came (what the cleaner reports for a photo it could not clean)
parentPort.postMessage({ kind: 'sanitized', body: new Uint8Array(workerData.input), keptParts: 3 })
