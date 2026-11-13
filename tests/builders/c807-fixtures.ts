// A C807 that answers like the documentation says, for the specs of its plugin. Every value is made up: the credentials, the
// token and the guides are fakes, never the ones of a real account.
export const C807_FAKE_USERNAME = 'fake-user'
export const C807_FAKE_PASSWORD = 'fake-password-do-not-leak'
export const C807_FAKE_TOKEN = 'fake-token-do-not-leak'
export const C807_FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-do-not-leak'

export interface C807Call {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

export interface FakeC807 {
  calls: C807Call[]
  // The tokens it hands out, in order, and how many it has handed out
  tokens: { issued: number }
  // The next calls that answer a bare 401 (an expired token) before they work
  expire: (count: number) => void
  // The orders it does not make a guide for
  skip: Set<string>
  fetch: typeof fetch
}

interface FakeGuide {
  guia: string
  orden: string
  solicitud: string
  codigo: string | null
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// What `set_registro`, `get_pdf`, the report and the history answer, kept in memory like the carrier would
export function fakeC807(): FakeC807 {
  const calls: C807Call[] = []
  const tokens = { issued: 0 }
  const skip = new Set<string>()
  let expired = 0
  let requests = 0
  const guides: FakeGuide[] = []

  const handler = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v
      ])
    )
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body
    })

    if (url.pathname === '/admin.php/sesion/get_token') {
      const expected = `Basic ${Buffer.from(`${C807_FAKE_USERNAME}:${C807_FAKE_PASSWORD}`).toString('base64')}`
      if (headers['authorization'] !== expected)
        return Promise.resolve(new Response(null, { status: 401 }))
      tokens.issued += 1
      return Promise.resolve(
        json({ access_token: `${C807_FAKE_TOKEN}-${tokens.issued}`, token_type: 'bearer' })
      )
    }
    // Only the last token issued works, as a token that was replaced does not
    if (headers['authorization'] !== `Bearer ${C807_FAKE_TOKEN}-${tokens.issued}`) {
      return Promise.resolve(new Response(null, { status: 401 }))
    }
    requests += 1
    if (expired > 0) {
      expired -= 1
      return Promise.resolve(new Response(null, { status: 401 }))
    }

    switch (url.pathname) {
      case '/guia.php/catalogo/departamento':
        return Promise.resolve(
          json([
            { id: '2', nombre: 'Ahuachapan', codigo: 'AHU' },
            { id: '3', nombre: 'Cabanas', codigo: 'CAB' }
          ])
        )
      case '/guia.php/catalogo/municipio':
        return Promise.resolve(
          json([
            { id: '2', nombre: 'AHUACHAPAN' },
            { id: '4', nombre: 'ATIQUIZAYA' }
          ])
        )
      case '/guia.php/api/set_registro': {
        const request = body as { guias: { orden: string; detalle: unknown[] }[] }
        const solicitud = `RECOLECTA-${requests}`
        const made: FakeGuide[] = request.guias
          .filter(guide => !skip.has(guide.orden))
          .flatMap((guide): FakeGuide[] =>
            guide.detalle.length > 1
              ? guide.detalle.map((_unused, index) => ({
                  guia: `fake-1-${guide.orden}-${index + 1}`,
                  orden: guide.orden,
                  solicitud,
                  codigo: String(index + 1)
                }))
              : [{ guia: `fake-1-${guide.orden}`, orden: guide.orden, solicitud, codigo: null }]
          )
        guides.push(...made)
        return Promise.resolve(
          json({
            recolecta: solicitud,
            guias: made.map(guide => ({
              ...guide,
              entrega_min: '2026-12-02 10:00:00',
              entrega_max: '2026-12-02 11:00:00',
              seguimiento: `https://tracking.example.test/${guide.guia}`
            }))
          })
        )
      }
      case '/guia.php/api/get_pdf':
        return Promise.resolve(json({ pdf: Buffer.from('%PDF-1.4 fake label').toString('base64') }))
      case '/guia.php/reporte/guias': {
        const { solicitud, orden, guia } = Object.fromEntries(url.searchParams)
        return Promise.resolve(
          json(
            guides
              .filter(
                g =>
                  (solicitud === undefined || g.solicitud === solicitud) &&
                  (orden === undefined || g.orden === orden) &&
                  (guia === undefined || g.guia === guia)
              )
              .map(g => ({
                ...g,
                seguimiento: `https://tracking.example.test/${g.guia}`
              }))
          )
        )
      }
      default:
        if (url.pathname.startsWith('/guia.php/api/get_historia/')) {
          return Promise.resolve(
            json([
              {
                estatus: 'Ingresado al sistema',
                codigo: '10',
                observaciones: null,
                fecha: '2026-12-01 09:00:00'
              },
              {
                estatus: 'Recogido en origen',
                codigo: '13',
                observaciones: '',
                fecha: '2026-12-01 14:30:00'
              }
            ])
          )
        }
        return Promise.resolve(json({ mensaje: 'not found' }, 404))
    }
  }

  return {
    calls,
    tokens,
    skip,
    expire: count => {
      expired = count
    },
    fetch: handler
  }
}

// A status of the webhook, as the documentation shows it
export const c807WebhookBody = {
  guia: 'fake-1-ORD-1001',
  codigo: '13',
  estatus: 'Recogido en origen',
  fecha: '2026-12-01 14:30:00',
  observaciones: '',
  latitud: '13.700000',
  longitud: '-89.200000'
}
