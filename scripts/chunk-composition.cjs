/* eslint-disable */
// throwaway: which source files make each client chunk (needs CHUNK_MAPS=1 at build)
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const dir = 'apps/web/.next/static/chunks'
const files = fs.readdirSync(dir)
const maps = files.filter(f => f.endsWith('.map'))
console.log('MAPFILES', maps.length, 'JS', files.filter(f => f.endsWith('.js')).length)
function collect(map, acc) {
  if (map.sections) for (const s of map.sections) collect(s.map, acc)
  else (map.sources || []).forEach((s, i) => acc.push([s, (map.sourcesContent?.[i] || '').length]))
}
const short = s =>
  s
    .replace(
      /^.*node_modules\/\.pnpm\/([^/]+)\/node_modules\/(.*)$/,
      (_, a, b) => 'NM:' + a.split('@')[0] + '/' + b.split('/').slice(0, 2).join('/')
    )
    .replace(/^.*\/(apps|libs)\//, '$1/')
for (const f of files.filter(f => f.endsWith('.js'))) {
  const gz = zlib.gzipSync(fs.readFileSync(path.join(dir, f))).length
  if (gz < 6000) continue
  let acc = []
  try {
    collect(JSON.parse(fs.readFileSync(path.join(dir, f + '.map'), 'utf8')), acc)
  } catch (e) {
    console.log('NOMAP', f, String(e).slice(0, 80))
  }
  const byDir = new Map()
  for (const [s, n] of acc) {
    const k = short(s).split('/').slice(0, 4).join('/')
    byDir.set(k, (byDir.get(k) || 0) + n)
  }
  const top = [...byDir].sort((a, b) => b[1] - a[1]).slice(0, 6)
  console.log(
    `CH ${f.slice(0, 8)} gz=${(gz / 1024).toFixed(1)} n=${acc.length} :: ` +
      top.map(([k, n]) => `${k}=${Math.round(n / 1024)}k`).join(' | ')
  )
}
