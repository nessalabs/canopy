import * as React from "react"
import katex from "katex"

import { cn } from "@/lib/utils"
import { CopyButton } from "./code-block"

import "katex/dist/katex.min.css"

export interface MathBlockProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** The TeX source, without dollar delimiters. */
  tex: string
  /** Render inline with the surrounding text instead of as a display block. */
  inline?: boolean
}

/**
 * A TeX formula rendered through KaTeX. While a formula streams in, invalid
 * intermediate source keeps the last successful render on screen instead of
 * flashing KaTeX's error state, so the formula grows without jitter; until
 * the first successful parse the raw source shows muted. Display formulas
 * carry a copy control that copies the TeX in markdown form (`$$…$$`).
 * MessageMarkdown composes it automatically for `$…$` and `$$…$$` math.
 */
function MathBlock({ tex, inline = false, className, ...props }: MathBlockProps) {
  const lastGood = React.useRef<{ html: string; inline: boolean } | null>(null)
  const rendered = React.useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: !inline,
        throwOnError: true,
      })
    } catch {
      return null
    }
  }, [inline, tex])
  React.useEffect(() => {
    if (rendered !== null) lastGood.current = { html: rendered, inline }
  }, [inline, rendered])
  // Mid-stream TeX is often momentarily invalid; keep the previous
  // successful render rather than swapping to an error state — but only a
  // render of the same mode, so a display formula never appears inline.
  const html =
    rendered ??
    (lastGood.current !== null && lastGood.current.inline === inline
      ? lastGood.current.html
      : null)

  if (inline) {
    if (html === null) {
      return (
        <span
          data-slot="math-block"
          data-inline="true"
          className={cn("font-mono text-[0.875em] text-muted-foreground", className)}
          {...props}
        >
          {tex}
        </span>
      )
    }
    return (
      <span
        data-slot="math-block"
        data-inline="true"
        className={className}
        dangerouslySetInnerHTML={{ __html: html }}
        {...props}
      />
    )
  }

  return (
    <div
      data-slot="math-block"
      className={cn("group/copy relative min-w-0 max-w-full", className)}
      {...props}
    >
      {html === null ? (
        <pre className="overflow-x-auto whitespace-pre-wrap py-1 font-mono text-[0.8125em] text-muted-foreground">
          {tex}
        </pre>
      ) : (
        <div
          className="overflow-x-auto overflow-y-hidden py-1 [&_.katex-display]:my-0"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <CopyButton text={`$$\n${tex}\n$$`} label="Copy math" className="top-0" />
    </div>
  )
}

export { MathBlock }
