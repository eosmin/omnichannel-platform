import type { CSSProperties } from 'react'

export const main: CSSProperties = {
  backgroundColor: '#f6f7f9',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
}
export const container: CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '24px auto',
  padding: '32px',
  maxWidth: '480px',
  borderRadius: '8px'
}
export const heading: CSSProperties = { fontSize: '20px', fontWeight: 600, color: '#111827' }
export const paragraph: CSSProperties = { fontSize: '15px', lineHeight: '22px', color: '#374151' }
export const buttonContainer: CSSProperties = { margin: '24px 0' }
export const button: CSSProperties = {
  backgroundColor: '#111827',
  color: '#ffffff',
  padding: '12px 20px',
  borderRadius: '6px',
  fontSize: '15px',
  textDecoration: 'none'
}
export const link: CSSProperties = { fontSize: '13px', color: '#2563eb', wordBreak: 'break-all' }
export const hr: CSSProperties = { borderColor: '#e5e7eb', margin: '24px 0' }
export const footer: CSSProperties = { fontSize: '13px', color: '#6b7280' }
