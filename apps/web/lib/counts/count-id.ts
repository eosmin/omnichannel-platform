// The id of a count in the address is a UUID: anything else is a page that does not exist, and is never put in the path
// of a request
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isCountId = (value: string): boolean => UUID.test(value)
