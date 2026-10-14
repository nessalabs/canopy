import { boxKey, type BoxRef } from './board'

/**
 * What the reader sends from the whiteboard, as tagged messages: the agent reads which box,
 * passage or decision the words are about from the tag, and the transcript shows a chip instead of
 * markup. One table describes every kind, so writing, reading and the prompt agree.
 */

export type WhiteboardMessage =
  /** A question about one box; with `draw`, the reader asked for the answer on the whiteboard. */
  | { kind: 'box'; ref: string; label: string; text: string; draw?: true }
  /** A question about a passage the reader selected — on a board (`ref` is its id) or in the plan document (`plan`). */
  | { kind: 'quote'; ref: string; quote: string; text: string }
  /** The reader's choices on decision cards, sent together, each with anything they added. */
  | { kind: 'decision'; choices: Choice[] }

/** One choice made on a decision card. */
export interface Choice {
  id: string
  question: string
  option: string
  label: string
  note: string
}

const attr = (value: string): string => value.replace(/"/g, '”')

/** `<canopy-box ref="overview/runner" label="Turn runner">` then the question; `draw="true"` after the label when the answer is to be drawn. */
export const boxMessage = (ref: BoxRef, label: string, text: string, draw = false): string => `<canopy-box ref="${boxKey(ref)}" label="${attr(label)}"${draw ? ' draw="true"' : ''}>\n${text}`

/** `<canopy-quote ref="overview">the passage</canopy-quote>` then the question. */
export const quoteMessage = (ref: string, quote: string, text: string): string => `<canopy-quote ref="${attr(ref)}">${quote.replace(/<\/canopy-quote>/g, '')}</canopy-quote>\n${text}`

/** Every choice as `<canopy-decision id="storage" question="Where…?" option="s3" label="Copy to S3">the note</canopy-decision>`. */
export const decisionMessage = (choices: readonly Choice[]): string =>
  choices
    .map((choice) => `<canopy-decision id="${attr(choice.id)}" question="${attr(choice.question)}" option="${attr(choice.option)}" label="${attr(choice.label)}">${choice.note.replace(/<\/canopy-decision>/g, '')}</canopy-decision>`)
    .join('\n')

const CHOICE = /<canopy-decision id="([^"]+)" question="([^"]*)" option="([^"]+)" label="([^"]*)">([\s\S]*?)<\/canopy-decision>/g

const READERS: ReadonlyArray<(text: string) => WhiteboardMessage | undefined> = [
  (text) => {
    const m = /^<canopy-box ref="([^"]+)" label="([^"]*)"( draw="true")?>\n?([\s\S]*)$/.exec(text)
    return m ? { kind: 'box', ref: m[1]!, label: m[2]!, text: m[4]!, ...(m[3] ? { draw: true as const } : {}) } : undefined
  },
  (text) => {
    const m = /^<canopy-quote ref="([^"]+)">([\s\S]*?)<\/canopy-quote>\n?([\s\S]*)$/.exec(text)
    return m ? { kind: 'quote', ref: m[1]!, quote: m[2]!, text: m[3]! } : undefined
  },
  (text) => {
    if (!text.startsWith('<canopy-decision ')) return undefined
    const choices = [...text.matchAll(CHOICE)].map(([, id, question, option, label, note]) => ({ id: id!, question: question!, option: option!, label: label!, note: note!.trim() }))
    return choices.length > 0 ? { kind: 'decision', choices } : undefined
  }
]

/** The whiteboard message a prompt is, or undefined for anything typed in the composer. */
export const parseWhiteboardMessage = (text: string): WhiteboardMessage | undefined => READERS.reduce<WhiteboardMessage | undefined>((found, read) => found ?? read(text), undefined)

/** A question about one box, or undefined. Kept for the places that only care about boxes. */
export function parseBoxMessage(text: string): { ref: string; label: string; text: string } | undefined {
  const message = parseWhiteboardMessage(text)
  return message?.kind === 'box' ? message : undefined
}
