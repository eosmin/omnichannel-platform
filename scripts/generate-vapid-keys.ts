import { generateVapidPair, vapidReport } from './lib/vapid'

// Usage: pnpm vapid:generate. Prints a new pair; never writes a file.
process.stdout.write(vapidReport(generateVapidPair()))
