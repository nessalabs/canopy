/**
 * A message one of Canopy's panes sends on the user's behalf to start a task — grouping the
 * change, say. The agent reads all of it; a transcript shows the title as what was asked, with the
 * brief folded away under it, since the brief (every hunk of a diff) is for the agent, not the
 * reader. It travels as the message itself rather than as system instructions, so its size is not
 * bounded by how an agent process takes its arguments.
 */

const TASK = /^<canopy-task title="([^"]*)">\n([\s\S]*?)\n?<\/canopy-task>\s*$/

/** The message that starts a task: `title` is what the user sees they asked, `brief` what the agent works from. */
export const taskMessage = (title: string, brief: string): string => `<canopy-task title="${title.replace(/"/g, '”')}">\n${brief}\n</canopy-task>`

/** A task message's parts, or undefined for anything a person typed. */
export function parseTaskMessage(text: string): { title: string; brief: string } | undefined {
  const match = TASK.exec(text.trim())
  return match ? { title: match[1]!, brief: match[2]! } : undefined
}

/** What a message reads as in one line — a task by its title, anything else as written. */
export const messageTitle = (text: string): string => parseTaskMessage(text)?.title ?? text
