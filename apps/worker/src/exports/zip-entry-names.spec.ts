import { ZipEntryNames } from './zip-entry-names'

describe('ZipEntryNames', () => {
  it('keeps a name that is alone', () => {
    expect(new ZipEntryNames().next('photo.jpg')).toBe('photo.jpg')
  })

  it('numbers a repeated name before its extension, without case', () => {
    const names = new ZipEntryNames()
    expect([
      names.next('image.jpg'),
      names.next('image.jpg'),
      names.next('IMAGE.JPG'),
      names.next('image.jpg')
    ]).toEqual(['image.jpg', 'image (2).jpg', 'IMAGE (3).JPG', 'image (4).jpg'])
  })

  it('numbers a name with no extension and one that is only an extension', () => {
    const names = new ZipEntryNames()
    expect([
      names.next('notes'),
      names.next('notes'),
      names.next('.env'),
      names.next('.env')
    ]).toEqual(['notes', 'notes (2)', '_env', '_env (2)'])
  })

  it('never lets an entry be a path', () => {
    const names = new ZipEntryNames()
    for (const hostile of ['../../etc/passwd', '/etc/passwd', 'a/b\\c.txt', '..']) {
      const name = names.next(hostile)
      expect(name).not.toMatch(/[/\\]/)
      expect(name.startsWith('.')).toBe(false)
    }
  })

  it('keeps a numbered name inside the length of a stored name', () => {
    const names = new ZipEntryNames()
    const long = `${'a'.repeat(116)}.jpg`
    names.next(long)
    expect(names.next(long).length).toBeLessThanOrEqual(120)
  })
})
