import { httpUrl, singleLineText } from './validation'

const schema = httpUrl(2048)

describe('httpUrl', () => {
  it.each([
    'https://example.com/a.png',
    'http://cdn.example.com:8080/a/b.jpg?x=1',
    'https://scontent.xx.fbcdn.net/v/t1/a.jpg',
    'https://wa.me/?text=hola%0Amundo',
    'https://shop.example.com/caf%E9.jpg',
    'https://shop.example.com/caf%C3%A9.jpg'
  ])('accepts %s', link => {
    expect(schema.safeParse(link).success).toBe(true)
  })

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>1</script>'],
    ['ftp', 'ftp://example.com/a'],
    ['protocol-relative', '//evil.example.com/a'],
    ['user and password', 'https://u:p@example.com/a'],
    ['user only', 'https://admin@example.com/a'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data'],
    ['metadata as an integer', 'http://2852039166/'],
    ['metadata in hex', 'http://0xa9fea9fe/'],
    ['this host', 'http://0.0.0.0/x'],
    ['private 172.16', 'http://172.16.0.1/x'],
    ['carrier-grade NAT', 'http://100.64.0.1/x'],
    ['octal loopback', 'http://0177.0.0.1/x'],
    ['ipv6 unique local', 'http://[fd00::1]/x'],
    ['ipv6 link-local', 'http://[fe80::1]/x'],
    ['ipv6 mapped loopback', 'http://[::ffff:7f00:1]/x'],
    ['loopback', 'http://127.0.0.1:8080/x'],
    ['loopback short form', 'http://127.1/x'],
    ['private 10', 'http://10.0.0.5/x'],
    ['private 192.168', 'https://192.168.1.1/x'],
    ['public ipv4 literal', 'https://8.8.8.8/a.png'],
    ['ipv6 loopback', 'http://[::1]/x'],
    ['ipv6 mapped metadata', 'http://[::ffff:a9fe:a9fe]/x'],
    ['public ipv6 literal', 'https://[2606:4700:4700::1111]/x'],
    ['localhost', 'http://localhost:8080/x'],
    ['localhost with a dot', 'http://localhost./x'],
    ['subdomain of localhost', 'http://app.localhost/x'],
    ['name without a dot', 'http://metadata/x'],
    ['mdns name', 'http://printer.local/x'],
    ['internal name', 'http://db.internal/x'],
    ['corp name', 'https://db.corp/x'],
    ['home.arpa', 'https://router.home.arpa/x'],
    ['localdomain', 'https://nas.localdomain/x'],
    ['right-to-left override in the path', 'https://example.com/\u202eexe.png'],
    ['left-to-right isolate', 'https://example.com/\u2066a.png'],
    ['left-to-right mark', 'https://example.com/\u200ea.png'],
    ['right-to-left mark', 'https://example.com/\u200fa.png'],
    ['bidi in the host', 'https://exa\u202emple.com/a.png'],
    ['tab', 'https://example.com/a\tb.png'],
    ['line break', 'https://example.com/a\nb.png'],
    ['carriage return', 'https://example.com/a\rb.png'],
    ['NUL', 'https://example.com/a\u0000b.png'],
    ['C1 control', 'https://example.com/a\u0085b.png'],
    ['zero-width space', 'https://example.com/a\u200bb.png'],
    ['percent-encoded override', 'https://example.com/%E2%80%AEexe.png']
  ])('refuses %s', (_name, link) => {
    expect(schema.safeParse(link).success).toBe(false)
  })

  it('refuses a link over the limit', () => {
    expect(httpUrl(30).safeParse(`https://example.com/${'a'.repeat(40)}`).success).toBe(false)
  })
})

describe('singleLineText', () => {
  const line = singleLineText(20, 1)

  it('keeps a name with accents, emoji and a joiner, and writes it in NFC', () => {
    expect(line.parse('  Jose\u0301 👩\u200d👩\u200d👧 ')).toBe('José 👩\u200d👩\u200d👧')
  })

  it('keeps the joiner that spells a word in Persian, and the spaces written with a non-breaking one as one', () => {
    expect(line.parse('می\u200cخواهم')).toBe('می\u200cخواهم')
    expect(line.parse('Ana\u00a0\u00a0Pérez')).toBe('Ana Pérez')
    expect(line.parse(`x${'\u0300'.repeat(4)}`)).toBe(`x${'\u0300'.repeat(4)}`)
  })

  it.each([
    ['a line break', 'dos\nlineas'],
    ['a tab', 'dos\tcolumnas'],
    ['a zero-width space', 'Zero\u200bwidth'],
    ['a direction override', 'Ana \u202egnirpS'],
    ['a line separator', 'dos\u2028lineas'],
    ['a paragraph separator', 'dos\u2029lineas'],
    ['a Hangul filler that draws blank', 'Ana\u3164Pérez'],
    ['a braille blank', 'Ana\u2800Pérez'],
    ['a joiner that joins nothing', 'Ana\u200d'],
    ['a name that is only a joiner', '\u200d'],
    ['two joiners in a row', 'Ana\u200d\u200dPérez'],
    ['a pile of combining marks', `A${'\u0300'.repeat(8)}`]
  ])('refuses %s', (_name, value) => {
    expect(line.safeParse(value).success).toBe(false)
  })
})
