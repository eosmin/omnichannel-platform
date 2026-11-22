import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { queuePrefixFor } from './queue-prefix'

describe('queuePrefixFor', () => {
  const app = 'postgresql://platform_app:secret@localhost:6432/platform_dev'

  it('is the same for the api and the worker, which differ by role, host and port', () => {
    const worker = 'postgresql://platform_worker:other@db.internal:5432/platform_dev'
    expect(queuePrefixFor(app)).toBe(queuePrefixFor(worker))
  })

  it('is the same for the api and the worker of .env.example', () => {
    const example = readFileSync(join(__dirname, '../../../../.env.example'), 'utf8')
    const url = /^DATABASE_URL=(.+)$/m.exec(example)?.[1]
    expect(url).toBeDefined()
    // The worker overrides the role of the api's URL (see .env.example), never the database
    const worker = (url ?? '').replace('platform_app', 'platform_worker')
    expect(queuePrefixFor(worker)).toBe(queuePrefixFor(url ?? ''))
  })

  it('differs for another database', () => {
    expect(queuePrefixFor(app)).not.toBe(
      queuePrefixFor('postgresql://platform_app:secret@localhost:6432/platform_qa')
    )
  })

  it('carries no credential and is safe as a key prefix', () => {
    expect(queuePrefixFor(app)).toMatch(/^q-[0-9a-f]{12}$/)
  })

  it('gives way to an explicit prefix, which is how two servers with one name are told apart', () => {
    expect(queuePrefixFor(app, 'mine')).toBe('mine')
  })
})
