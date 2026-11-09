import {
  FADE_MS,
  HIGHLIGHT_CLASSES,
  HIGHLIGHT_MS,
  announce,
  highlightFor,
  TRANSITION_CLASSES
} from './jump-highlight'

const fakeElement = () => {
  const classes = new Set<string>()
  return {
    classes,
    classList: {
      add: (...names: string[]) => names.forEach(name => classes.add(name)),
      remove: (...names: string[]) => names.forEach(name => classes.delete(name))
    }
  }
}

describe('highlightFor', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('marks the element at once and takes the mark off after the time, so it fades', () => {
    const element = fakeElement()

    highlightFor(element)

    for (const name of HIGHLIGHT_CLASSES) expect(element.classes.has(name)).toBe(true)
    for (const name of TRANSITION_CLASSES) expect(element.classes.has(name)).toBe(true)
    // The mark goes first, with the transition still on so that it fades; the transition goes after, so the
    // focus ring of the element is instant again
    jest.advanceTimersByTime(HIGHLIGHT_MS + 1)
    for (const name of HIGHLIGHT_CLASSES) expect(element.classes.has(name)).toBe(false)
    for (const name of TRANSITION_CLASSES) expect(element.classes.has(name)).toBe(true)
    jest.advanceTimersByTime(FADE_MS + 1)
    expect(element.classes.size).toBe(0)
  })

  it('a second jump to the same element starts the time over and never leaves the mark behind', () => {
    const element = fakeElement()

    highlightFor(element)
    jest.advanceTimersByTime(HIGHLIGHT_MS - 100)
    highlightFor(element)
    jest.advanceTimersByTime(200)
    // The first timer would have cleared it by now
    expect(element.classes.size).toBeGreaterThan(0)
    jest.advanceTimersByTime(HIGHLIGHT_MS + FADE_MS)
    expect(element.classes.size).toBe(0)
  })

  it('moving to another element takes the mark off the first one', () => {
    const first = fakeElement()
    const second = fakeElement()

    highlightFor(first)
    highlightFor(second)

    expect(first.classes.size).toBe(0)
    expect(second.classes.size).toBeGreaterThan(0)
    jest.advanceTimersByTime(HIGHLIGHT_MS + FADE_MS + 1)
    expect(second.classes.size).toBe(0)
  })
})

describe('announce', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('says the words again when they are the same as the last time: the region is emptied between', () => {
    const region = { textContent: '' as string | null }
    const seen: (string | null)[] = []
    announce(region, 'Highlighted')
    jest.advanceTimersByTime(60)
    seen.push(region.textContent)
    announce(region, 'Highlighted')
    // Emptied at once, so the reader sees a change when the words come back
    seen.push(region.textContent)
    jest.advanceTimersByTime(60)
    seen.push(region.textContent)

    expect(seen).toEqual(['Highlighted', '', 'Highlighted'])
  })

  it('leaves the region empty after a while, and does nothing without a region', () => {
    const region = { textContent: '' as string | null }
    announce(region, 'Highlighted')
    jest.advanceTimersByTime(60 + HIGHLIGHT_MS + 1)

    expect(region.textContent).toBe('')
    expect(() => announce(null, 'x')).not.toThrow()
  })
})
