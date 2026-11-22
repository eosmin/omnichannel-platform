import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// What a processor does with a job is decided where it is written, so this reads the processors and holds them to the rules of Step 7.3-B7.
// A job crosses Redis: it is checked on entry against a schema that names exactly the keys of its job type, and one that does not fit is
// refused for good without echoing what it held.

// A schema that is not wrapped in `exactly<Job>()`, with the reason. Each is still checked by tsc against its job type, only in one direction.
const NOT_EXACTLY: Readonly<Record<string, string>> = {
  rawEventSchema:
    'The base of the two analytics event schemas, which are wrapped (`trackEventSchema`) or checked against the job type (`trackSearchSchema`).',
  trackSearchSchema:
    'Its `data` is narrower than the `Record<string, unknown>` of the job type, so the two are assignable in one direction only.',
  mediaJobSchema:
    'One schema for two job types whose scope is a union (a store or a person), which `exactly` cannot compare key by key.'
}

const processorFiles = readdirSync(__dirname)
  .filter(name => name.endsWith('.processor.ts') || name.endsWith('-job.schema.ts'))
  .map(name => ({ name, source: stripComments(readFileSync(join(__dirname, name), 'utf8')) }))

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
}

describe('the processors of the worker read their jobs with an exact schema', () => {
  it('finds the processors', () => {
    expect(processorFiles.length).toBeGreaterThanOrEqual(10)
  })

  it.each(processorFiles.map(file => [file.name, file.source]))(
    '%s wraps every schema of a job in exactly<Job>(), or says why not',
    (_name, source) => {
      const unwrapped = [
        ...source.matchAll(/^(?:export )?const (\w+Schema)\b[^=\n]*=\s*(?!exactly<)(\S+)/gm)
      ]
        .flatMap(match => match[1] ?? [])
        .filter(schema => !(schema in NOT_EXACTLY))
      expect(unwrapped).toEqual([])
    }
  )

  it.each(processorFiles.map(file => [file.name, file.source]))(
    '%s never casts the data of a job to its type, which would be reading it unchecked',
    (_name, source) => {
      expect(source).not.toMatch(/\b(?:job\.)?data\s+as\s/)
    }
  )

  it.each(processorFiles.map(file => [file.name, file.source]))(
    '%s lets no schema pass unknown keys on',
    (_name, source) => {
      expect(source).not.toMatch(/\.passthrough\(|looseObject|\.catchall\(/)
    }
  )

  it.each(processorFiles.map(file => [file.name, file.source]))(
    '%s refuses a job with a fixed message: no template literal, no message of a parser',
    (_name, source) => {
      const refusals = [
        ...source.matchAll(/new (?:Unrecoverable|JobRejected)Error\(([^)]*)\)/g)
      ].map(match => match[1] ?? '')
      for (const argument of refusals) {
        expect(argument).not.toMatch(/`/)
        // A ZodError's message lists the paths and values it met; the message of another error is the job context's own
        expect(argument).not.toMatch(/parsed\.error|\.error\.message/)
      }
    }
  )

  it('keeps every exception above in use, so that a list of excuses never outlives its schema', () => {
    const all = processorFiles.map(file => file.source).join('\n')
    for (const schema of Object.keys(NOT_EXACTLY)) {
      expect(all).toMatch(new RegExp(`const ${schema}\\b`))
    }
  })
})
