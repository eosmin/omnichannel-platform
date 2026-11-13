import { createHmac } from 'node:crypto'

// A Forza that answers like the API v2.2 documentation says, for the contract suite and the specs of its plugin. Every value
// is made up: the application code, the key, the account and the guides are fakes, never the ones of a real account. It checks
// the signature of each call, so a plugin that signs wrongly is refused as the real service refuses it.
export const FORZA_FAKE_COD_APP = 'FAKE-COD-APP'
export const FORZA_FAKE_SECRET_KEY = 'fake-secret-key-do-not-leak-0123'
export const FORZA_FAKE_ACCOUNT = '000000000000'
export const FORZA_FAKE_BASE_URL = 'https://forza.example.test:40467'
export const FORZA_FAKE_GUIDE = 'FD10000001'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

export interface ForzaCall {
  url: string
  method: string
  params: Record<string, unknown>
}

export interface FakeForza {
  calls: ForzaCall[]
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

const answer = (body: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      CodApp: FORZA_FAKE_COD_APP,
      PayLoad: Buffer.from(JSON.stringify(body)).toString('base64')
    })
  )
const ok = (extra: Record<string, unknown>): Response =>
  answer({ StatusCode: 200, Description: 'Success', ...extra })

const objectValueOf = (method: string): Record<string, unknown> => {
  switch (method) {
    case 'GetListProvincesByHeaderCode':
      return {
        ObjectValue: {
          IdResult: 200,
          Message: 'Success',
          provinceLists: [
            { HeaderCode: '01', IdProvince: '7', ProvinceName: 'Guatemala', IdCountry: 'GT' },
            { HeaderCode: '04', IdProvince: '3', ProvinceName: 'Chimaltenango', IdCountry: 'GT' }
          ]
        }
      }
    case 'GetListTownshipByHeaderCode':
      return {
        ObjectValue: {
          IdResult: 200,
          Message: 'Success',
          TownshipByHeaderCodes: [
            { HeaderCodeTownship: '0401', HeaderCode: '04', TownshipName: 'Chimaltenango' },
            { HeaderCodeTownship: '0402', HeaderCode: '04', TownshipName: 'San Jose Poaquil' }
          ]
        }
      }
    case 'GetServiceByHeaderCodeRequest':
      return {
        ObjectValue: [
          {
            TrackingNumber: FORZA_FAKE_GUIDE,
            Segment: 'FOR',
            Price: '0',
            Currency: 'GTQ',
            PDF: [`${FORZA_FAKE_BASE_URL}/Guia?id=ZmFrZQ`]
          }
        ]
      }
    case 'GetGuideReprintRequest':
      return {
        ObjectValue: [
          { TrackingNumber: FORZA_FAKE_GUIDE, PDF: [`${FORZA_FAKE_BASE_URL}/Guia?id=ZmFrZQ`] }
        ]
      }
    case 'SetCancelGuides':
      return {
        ObjectValue: [
          { Result: [{ DescriptionResult: 'La anulaciòn de guías fue realizada exitosamente.' }] }
        ]
      }
    case 'GetTrackOrderDetail':
      return {
        TrackOrder: {
          GuideSerie: 'FD',
          GuideNumber: 10000001,
          OrderDetail: {
            id: FORZA_FAKE_GUIDE,
            milestones: [
              { eventId: 1, stageId: 1, date: '2026-12-01 09:13:41Z', title: 'Solicitado' },
              { eventId: 2, stageId: 2, date: '2026-12-01 14:00:00Z', title: 'Recolectado' },
              { eventId: 3, stageId: 5, date: '2026-12-02 10:30:00Z', title: 'Entregado' }
            ]
          }
        }
      }
    case 'SetPickupServiceByIntegration':
      return { ObjectValue: { IdResult: 200, Message: 'Success', ServiceId: 900001 } }
    default:
      return {}
  }
}

export function fakeForza(): FakeForza {
  const calls: ForzaCall[] = []
  return {
    calls,
    fetch: (url, init) => {
      // The label link is a plain GET on the same host
      if (init?.method === 'GET') return Promise.resolve(new Response(PDF))
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = JSON.parse(init?.body as string) as { CodApp: string; PayLoad: string }
      const json = Buffer.from(body.PayLoad, 'base64').toString('utf8')
      const expected = createHmac('sha256', FORZA_FAKE_SECRET_KEY).update(json).digest('base64')
      if (body.CodApp !== FORZA_FAKE_COD_APP || headers['LauValue'] !== expected) {
        return Promise.resolve(
          answer({
            StatusCode: 401,
            Description: 'Unauthorized - No autorizado. LauValue inválido.'
          })
        )
      }
      const request = JSON.parse(json) as { Method: string; Params: Record<string, unknown> }
      calls.push({ url, method: request.Method, params: request.Params })
      return Promise.resolve(ok(objectValueOf(request.Method)))
    }
  }
}
