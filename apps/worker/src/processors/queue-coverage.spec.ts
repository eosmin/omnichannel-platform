import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { QueueNames } from '@platform/core/queues'

// A queue nobody consumes is where jobs go to wait forever (an `email.engagement` job sat in
// `analytics` for hours before anyone saw it). Every queue has a processor in the worker, or is named
// here with the reason and the step that gives it one.
const WITHOUT_PROCESSOR: Readonly<Record<string, string>> = {
  [QueueNames.WEBHOOKS]:
    'Milestone 4: outbound webhooks and the carrier events. Nothing queues here in the MVP.',
  [QueueNames.DEAD_LETTER]:
    'By design: it keeps exhausted jobs for a person to inspect (Step 7.4 watches it).'
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('the queues of the worker', () => {
  const source = sourceFiles(join(__dirname, '..'))
    // A decorator in a comment is not a processor
    .map(file => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))
    .join('\n')
  const consumed = new Set(
    [...source.matchAll(/@Processor\(QueueNames\.([A-Z_]+)/g)].map(match => match[1])
  )
  const nameOf = (queue: string): string | undefined =>
    Object.entries(QueueNames).find(([, value]) => value === queue)?.[0]

  it.each(Object.values(QueueNames))('%s has a processor or a written reason', queue => {
    const name = nameOf(queue)
    expect(name).toBeDefined()
    expect(consumed.has(name ?? '') || queue in WITHOUT_PROCESSOR).toBe(true)
  })

  it('does not excuse a queue that has a processor', () => {
    for (const queue of Object.keys(WITHOUT_PROCESSOR)) {
      expect(consumed.has(nameOf(queue) ?? '')).toBe(false)
    }
  })
})
