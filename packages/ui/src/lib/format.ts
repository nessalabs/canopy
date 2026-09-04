const UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.35, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year']
]

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "3 hours ago" style label for an epoch-ms timestamp. */
export function relativeTime(at: number, now = Date.now()): string {
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
