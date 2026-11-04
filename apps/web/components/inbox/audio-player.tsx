'use client'

import { Download, Pause, Play } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState
} from 'react'

import { clockOf, nextSpeed, positionOf } from '../../lib/inbox/audio-clock'
import { cn } from '../../lib/utils'

// The keys of the bar move the audio this many seconds
const KEY_STEP_SECONDS = 5
// HTMLMediaElement.HAVE_METADATA: the length and the size are known
const HAVE_METADATA = 1

// A player of fixed width: it does not grow with the length of the audio, so a thread of voice notes
// keeps its shape. Play and pause, a bar that can be dragged, the time that went and the total, and a
// button that cycles the speed. It loads on its own chunk (the inbox has a script budget) and the audio
// itself is asked for only when the bubble is drawn (metadata), never played by itself.
export default function AudioPlayer({ src, label }: { src: string; label: string }): ReactElement {
  const t = useTranslations('inbox.thread.audio')
  const audio = useRef<HTMLAudioElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const [isPlaying, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const speedRef = useRef(speed)
  speedRef.current = speed
  const [hasFailed, setFailed] = useState(false)

  // A browser that cannot decode the format (an Ogg Opus voice note in an old Safari) says so at once
  // instead of showing a player that does nothing
  useEffect(() => {
    // A new link (the signed one was renewed) is a new load: nothing of the old one stands
    setFailed(false)
    setPlaying(false)
    setCurrent(0)
    setDuration(0)
    // The browser may have read the length before the handlers were there (a cached file, a fast
    // connection): ask the element instead of waiting for an event that already happened
    const element = audio.current
    if (element === null) return
    if (element.readyState >= HAVE_METADATA) setDuration(element.duration)
    // Loading a source puts the rate back to 1: the speed on the button is the one that plays
    element.playbackRate = speedRef.current
  }, [src])

  const length = Number.isFinite(duration) ? duration : 0
  const seek = (seconds: number): void => {
    if (audio.current === null) return
    audio.current.currentTime = seconds
    setCurrent(seconds)
  }
  const seekTo = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = bar.current?.getBoundingClientRect()
    if (rect === undefined) return
    seek(positionOf({ x: event.clientX, left: rect.left, width: rect.width, duration: length }))
  }
  const toggle = (): void => {
    const element = audio.current
    if (element === null) return
    if (element.paused) {
      // Only a file the browser cannot decode ends the player; a play() cut short by a pause, or one the
      // browser held back, leaves it as it was
      element.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'NotSupportedError') setFailed(true)
      })
    } else {
      element.pause()
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // From where the element is, not from what the bar last drew
    const now = audio.current?.currentTime ?? current
    const steps: Record<string, number> = {
      ArrowLeft: now - KEY_STEP_SECONDS,
      ArrowDown: now - KEY_STEP_SECONDS,
      ArrowRight: now + KEY_STEP_SECONDS,
      ArrowUp: now + KEY_STEP_SECONDS,
      Home: 0,
      End: length
    }
    const to = steps[event.key]
    if (to === undefined) return
    event.preventDefault()
    seek(Math.min(length, Math.max(0, to)))
  }

  if (hasFailed) {
    return (
      <a
        href={src}
        download={label}
        className="focus-visible:ring-ring bg-background/60 flex w-[min(260px,100%)] items-center gap-2 rounded-md border px-2 py-1.5 text-xs outline-none hover:underline focus-visible:ring-2"
      >
        <Download aria-hidden className="size-4 shrink-0" />
        <span role="status">{t('failed')}</span>
        <span className="sr-only">{t('download')}</span>
      </a>
    )
  }

  const percent = length > 0 ? Math.min(100, (current / length) * 100) : 0
  const position = t('position', { elapsed: clockOf(current), total: clockOf(length) })
  return (
    <div
      className="bg-background/60 flex w-[min(260px,100%)] items-center gap-2 rounded-full border px-2 py-1"
      role="group"
      aria-label={label}
    >
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={event => setDuration(event.currentTarget.duration)}
        onDurationChange={event => setDuration(event.currentTarget.duration)}
        onTimeUpdate={event => {
          if (!isDragging.current) setCurrent(event.currentTarget.currentTime)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setCurrent(0)
          if (audio.current !== null) audio.current.currentTime = 0
        }}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        aria-label={isPlaying ? t('pause') : t('play')}
        className="bg-primary text-primary-foreground focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 pointer-coarse:size-10"
        onClick={toggle}
      >
        {isPlaying ? (
          <Pause aria-hidden className="size-4" />
        ) : (
          <Play aria-hidden className="size-4" />
        )}
      </button>
      <div
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label={t('seek')}
        aria-valuemin={0}
        aria-valuemax={Math.floor(length)}
        aria-valuenow={Math.floor(current)}
        aria-valuetext={position}
        className="focus-visible:ring-ring bg-muted relative h-1.5 min-w-8 flex-1 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2"
        onKeyDown={onKeyDown}
        onPointerDown={event => {
          isDragging.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          seekTo(event)
        }}
        onPointerMove={event => {
          if (isDragging.current) seekTo(event)
        }}
        onPointerUp={event => {
          isDragging.current = false
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={() => {
          isDragging.current = false
        }}
        onLostPointerCapture={() => {
          isDragging.current = false
        }}
      >
        <div className="bg-primary h-full rounded-full" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums" aria-hidden>
        {clockOf(current)}/{clockOf(length)}
      </span>
      <button
        type="button"
        aria-label={t('speed', { speed })}
        className={cn(
          'focus-visible:ring-ring hover:bg-accent shrink-0 rounded px-1 text-[11px] font-medium tabular-nums outline-none focus-visible:ring-2'
        )}
        onClick={() => {
          const next = nextSpeed(speed)
          if (audio.current !== null) audio.current.playbackRate = next
          setSpeed(next)
        }}
      >
        {speed}x
      </button>
    </div>
  )
}
