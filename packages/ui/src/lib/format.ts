const UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.35, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year']
]

const FORMATS = {
  long: new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }),
  narrow: new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' })
}

/** "3 hours ago" style label for an epoch-ms timestamp; `narrow` says "3h ago" where room is short. */
export function relativeTime(at: number, now = Date.now(), style: keyof typeof FORMATS = 'long'): string {
  const rtf = FORMATS[style]
  let value = (at - now) / 1000
  for (const [step, unit] of UNITS) {
    if (Math.abs(value) < step) return rtf.format(Math.round(value), unit)
    value /= step
  }
  return rtf.format(Math.round(value), 'year')
}

export const absoluteTime = (at: number): string => new Date(at).toLocaleString()

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

export const shortPath = (path: string): string => path.replace(/^\/home\/[^/]+/, '~')
