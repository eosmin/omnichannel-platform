const { parentPort } = require('node:worker_threads')
// Buffers are outside the heap that resourceLimits bounds: 3 GB of them (untouched pages, so little of it is resident) and then an answer
const kept = []
for (let n = 0; n < 24; n += 1) kept.push(new Uint8Array(128 * 1024 * 1024))
parentPort.postMessage({ kind: 'untouched', why: 'not_cleanable', held: kept.length })
