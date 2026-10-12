/** The slice of mdast the text-linking plugins touch. */
export interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/** A run of prose cut into plain text and the pieces that become links, each with where it goes. */
export type LinkedPart = string | { raw: string; url: string }

const link = (url: string, child: MdNode): MdNode => ({ type: 'link', url, children: [child] })

/**
 * Turns references in an answer's prose into links: `split` finds them in each run of text, and
 * `code`, given, links a code span that is a reference on its own. Text already inside a link is
 * left alone, as are fenced blocks, which have no text children.
 */
export function linkText(node: MdNode, split: (text: string) => LinkedPart[], code?: (value: string) => string | null): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === 'text' && child.value) return split(child.value).map((part) => (typeof part === 'string' ? { type: 'text', value: part } : link(part.url, { type: 'text', value: part.raw })))
    const url = child.type === 'inlineCode' && child.value && code ? code(child.value) : null
    if (url) return [link(url, child)]
    linkText(child, split, code)
    return [child]
  })
}
