// The minimum tests the tax authority of El Salvador asks of an issuer before it authorizes it (Step 4B.7c-6): 90 invoices, 75 tax credit
// documents, 50 credit notes, 25 debit notes, 50 remission notes and 25 invoices of an excluded subject with seal, 5 invalidations and 5 contingencies, made of invented data in many shapes.
//
// It runs the plan through the port of a provider and never through the lifecycle of the platform, so it needs no database. By default the
// provider is the simulator and nothing leaves the machine. Against the real sandbox it runs only on the machine of the owner, only with
// the environment below set AND the confirmation given, and it never prints, logs or saves a credential, a token, a password, a tax number
// or a signed document: the report carries the ids of the plan, the kinds, the outcomes and the codes, and it is checked against the secrets
// before it is shown. The logic is in `conformance-cli.ts` (tested); this file only connects it to the process.
//
// Usage:
//   pnpm fiscal:conformance [--provider simulator|sv] [--dry-run] [--seed 2026] [--batch b1]
//        [--offset 0] [--counts invoices=90,taxCredits=75,creditNotes=50,debitNotes=25,remissionNotes=50,excludedSubjects=25,voids=5,contingencies=5,deferredPerContingency=2]
//        [--out report.json] [--json] [--help-env]
//
//   --provider simulator   (default) the simulator: documents, credit notes and invalidations; it has no contingency mode, so those are skipped
//   --provider sv --dry-run  builds every document with the rules of the provider and sends nothing (no environment needed)
//   --provider sv          the real sandbox: needs the names listed by `--help-env` and DTE_SANDBOX_CONFIRM=send-to-sandbox
//   --offset N             the numbers of the series start after N: a second run uses the `next --offset` the first one printed
//   --batch NAME           a second run with another name is not a duplicate of the first
import { writeFileSync } from 'node:fs'
import process, { argv, env, stderr, stdout } from 'node:process'

import { runConformanceCli } from './conformance-cli'

// The exit code is set and the process ends by itself, so that what was written to a pipe is not cut off
process.exitCode = await runConformanceCli(argv.slice(2), env, {
  out: text => stdout.write(text),
  err: text => stderr.write(text),
  write: (path, text) => writeFileSync(path, text)
})
