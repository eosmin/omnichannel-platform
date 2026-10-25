import { Header } from '@nestjs/common'

// For the routes that answer with a token or with data of a person: no browser and no proxy may keep
// the response (RFC 6749 section 5.1 asks it of every response that carries a token)
export const NoStore = (): MethodDecorator => Header('Cache-Control', 'no-store')
