/* eslint-disable */
// throwaway: which source files make each client chunk (needs CHUNK_MAPS=1 at build)
const fs = require('node:fs')
const path = require('node:path')
const dir = 'apps/web/.next/static/chunks'
const zlib = require('node:zlib')
const rows = []
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js')) continue
  const code = fs.readFileSync(path.join(dir, f))
  const gz = zlib.gzipSync(code).length
  let sources = []
  try {
    const map = JSON.parse(fs.readFileSync(path.join(dir, f + '.map'), 'utf8'))
    sources = (map.sources || []).map((s, i) => [s, (map.sourcesContent?.[i] || '').length])
  } catch {}
  rows.push({ f, gz, sources })
}
rows.sort((a, b) => b.gz - a.gz)
for (const r of rows.filter(r => r.gz > 3000)) {
  console.log(`CHUNK ${r.f} gz=${(r.gz / 1024).toFixed(2)}KB sources=${r.sources.length}`)
  const top = r.sources
    .map(([s, n]) => [s.replace(/^.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'NM:'), n])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
  for (const [s, n] of top) console.log(`   ${String(n).padStart(7)} ${s}`)
}
