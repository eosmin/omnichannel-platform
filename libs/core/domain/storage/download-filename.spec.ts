import { downloadFilename } from './download-filename'

describe('downloadFilename', () => {
  it.each([
    ['photo.png', 'image/png'],
    ['photo.JPG', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['invoice.pdf', 'application/pdf'],
    ['notes.txt', 'text/plain'],
    ['clip.mov', 'video/quicktime'],
    ['song.mp3', 'audio/mpeg'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['data.csv', 'text/plain'],
    ['readme.md', 'text/plain']
  ])('keeps %s, whose extension is one of %s', (name, type) => {
    expect(downloadFilename(name, type)).toBe(name)
  })

  // The name is the sender's; the type was read from the bytes. A name whose extension says something else
  // would open as that other thing when it is double-clicked.
  it.each([
    ['x.exe', 'application/pdf', 'x.exe.pdf'],
    ['a.pdf.exe', 'application/pdf', 'a.pdf.exe.pdf'],
    ['run.bat', 'text/plain', 'run.bat.txt'],
    ['setup.ps1', 'text/plain', 'setup.ps1.txt'],
    ['page.html', 'image/png', 'page.html.png'],
    ['photo', 'image/png', 'photo.png'],
    ['photo.', 'image/jpeg', 'photo.jpg'],
    ['song.exe', 'audio/mpeg', 'song.exe.mp3'],
    ['...', 'application/pdf', 'file.pdf'],
    ['', 'image/png', 'file.png'],
    ['.exe', 'application/pdf', '.exe.pdf'],
    ['report.pdf.', 'application/pdf', 'report.pdf'],
    ['data.sh', 'text/plain', 'data.sh.txt'],
    ['run.cmd', 'text/plain', 'run.cmd.txt']
  ])('turns %s declared %s into %s', (name, type, expected) => {
    expect(downloadFilename(name, type)).toBe(expected)
  })

  it('leaves a name alone when the type is not one of the uploads (an export, an archive)', () => {
    expect(downloadFilename('export.zip', 'application/zip')).toBe('export.zip')
    expect(downloadFilename('data.csv', 'text/csv')).toBe('data.csv')
  })

  it('ignores the case and the parameters of the type', () => {
    expect(downloadFilename('x.exe', 'Application/PDF; charset=binary')).toBe('x.exe.pdf')
  })
})
