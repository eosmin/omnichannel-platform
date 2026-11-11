import { createTranslator } from 'next-intl'

import { MessageType } from '@platform/core/domain'

import en from '../../messages/en.json'
import es from '../../messages/es.json'

import { unsupportedKindOf } from './attachment-batch'

const textOf = (locale: 'en' | 'es', kind: string): string => {
  const messages = locale === 'en' ? en : es
  const t = createTranslator({ locale, messages, namespace: 'inbox.composer.attach' })
  return t('unsupported', { kind })
}

// What the tray says when a channel does not take a file (`CHANNEL_CAPABILITY_UNSUPPORTED`): it names the kind of the file, in each
// language, and says "this kind of file" only when it does not know which
describe('the text of a file the channel does not accept', () => {
  it.each([
    [MessageType.IMAGE, 'images', 'imágenes'],
    [MessageType.VIDEO, 'videos', 'videos'],
    [MessageType.AUDIO, 'audio files', 'audios'],
    [MessageType.DOCUMENT, 'documents', 'documentos']
  ])('names %s', (kind, inEnglish, inSpanish) => {
    expect(textOf('en', kind)).toBe(`This channel does not accept ${inEnglish}.`)
    expect(textOf('es', kind)).toBe(`Este canal no admite ${inSpanish}.`)
  })

  it('gives the text the type of the file the tray holds, and none when it holds no type', () => {
    expect(unsupportedKindOf(MessageType.IMAGE)).toBe(MessageType.IMAGE)
    expect(unsupportedKindOf(MessageType.VIDEO)).toBe(MessageType.VIDEO)
    expect(unsupportedKindOf(MessageType.AUDIO)).toBe(MessageType.AUDIO)
    expect(unsupportedKindOf(MessageType.DOCUMENT)).toBe(MessageType.DOCUMENT)
    expect(unsupportedKindOf(null)).toBe('other')
  })

  it('falls back to the kind of file in general when it is not known', () => {
    expect(textOf('en', 'other')).toBe('This channel does not accept this kind of file.')
    expect(textOf('es', 'other')).toBe('Este canal no admite este tipo de archivo.')
  })
})
