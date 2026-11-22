// Holds on to more than the memory limit of the thread allows
const kept = []
for (;;) kept.push(new Array(1_000_000).fill(Math.random()))
