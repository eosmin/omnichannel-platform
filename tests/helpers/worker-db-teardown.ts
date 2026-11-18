import { closeWorkerPrisma } from './worker-db'

// Listed in setupFilesAfterEnv of the jest configs of the suites: the connections that createWorkerPrisma opened close when the
// file ends, after the afterAll of the suite that used them
afterAll(async () => {
  await closeWorkerPrisma()
})
