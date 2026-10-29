// A link that a provider or a plugin hands over, kept only when it is https and carries no user or
// password: those would travel to whoever follows the link
export function isPlainHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}
