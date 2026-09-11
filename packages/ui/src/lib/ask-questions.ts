/**
 * `AskUserQuestion` is the tool Claude Code uses to put a multiple-choice question to the user. It
 * arrives as a permission ask, so without this it would render as a JSON approval nobody can read.
 * The answer goes back as the tool's rewritten input: `answers` keyed by the question text, which
 * is what the CLI reads back out.
 */

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  /** The question text, and the key its answer submits under. */
  question: string
  /** A few words naming the topic, shown above the question. */
  header?: string
  options: AskOption[]
  /** Several options may be chosen at once. */
  multiSelect: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseOption(value: unknown): AskOption | null {
  if (typeof value === 'string') return { label: value }
  if (!isRecord(value) || typeof value.label !== 'string') return null
  return { label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }
}

/**
 * The questions inside an `AskUserQuestion` input, or null when the tool's input is not shaped
 * like one — a provider may change it, and a half-read form is worse than the JSON it replaced.
 */
export function parseAskQuestions(input: unknown): AskQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null
  const questions: AskQuestion[] = []
  for (const entry of input.questions) {
    if (!isRecord(entry) || typeof entry.question !== 'string') return null
    const options = Array.isArray(entry.options) ? entry.options.map(parseOption).filter((option): option is AskOption => option !== null) : []
    questions.push({
      question: entry.question,
      ...(typeof entry.header === 'string' && entry.header ? { header: entry.header } : {}),
      options,
      multiSelect: entry.multiSelect === true
    })
  }
  return questions.length > 0 ? questions : null
}

/**
 * One question's answer: the labels picked, and anything typed into its own "Other" box, as one
 * comma-joined string — the shape the CLI expects for both single and multi-select questions.
 */
export function answerFor(selected: readonly string[], other: string): string {
  return [...selected, other.trim()].filter((part) => part !== '').join(', ')
}

/** The tool input to allow with: what the agent proposed, plus the answers keyed by question. */
export function answeredInput(input: unknown, answers: Record<string, string>): Record<string, unknown> {
  return { ...(isRecord(input) ? input : {}), answers }
}
