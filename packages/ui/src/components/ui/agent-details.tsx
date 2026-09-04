"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface AgentDetailsProps
  extends Omit<React.ComponentProps<"div">, "title"> {
  /** The conversation or agent title. */
  title: React.ReactNode
}

/**
 * The identity of an agent conversation: a title, a row of compact actions,
 * and an Info section for the project, model, runtime, and timestamps the
 * host already knows. The panel draws nothing about how it is shown — put
 * it in a Sheet, an overlay, or a sidebar. The host owns the facts.
 */
function AgentDetails({
  title,
  className,
  children,
  ...props
}: AgentDetailsProps) {
  return (
    <div
      data-slot="agent-details"
      className={cn(
        "flex w-full min-w-0 flex-col items-center gap-5 font-sans",
        className,
      )}
      {...props}
    >
      <h3
        data-slot="agent-details-title"
        className="m-0 max-w-full px-2 text-center font-sans nessa-text-6 font-semibold leading-7 text-foreground"
      >
        {title}
      </h3>
      {children}
    </div>
  )
}

/**
 * The circular action row under the title — Edit, Pin, Share. Each child
 * is typically an AgentDetailsAction.
 */
function AgentDetailsActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="agent-details-actions"
      className={cn("flex items-center justify-center gap-5", className)}
      {...props}
    />
  )
}

export interface AgentDetailsActionProps
  extends Omit<React.ComponentProps<"button">, "children"> {
  /** The action's name, shown under the icon and used as the accessible name. */
  label: string
  /** The action's glyph. The control owns sizing and color. */
  children?: React.ReactNode
}

/**
 * One circular action under the details title: icon above a muted label.
 */
function AgentDetailsAction({
  label,
  className,
  children,
  ...props
}: AgentDetailsActionProps) {
  return (
    <button
      type="button"
      data-slot="agent-details-action"
      aria-label={label}
      className={cn(
        "flex w-14 flex-col items-center gap-1.5 rounded-xl border-0 bg-transparent p-0 font-sans outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-accent [&_svg]:size-4">
        {children}
      </span>
      <span className="nessa-text-1 text-muted-foreground">{label}</span>
    </button>
  )
}

export interface AgentDetailsSectionProps
  extends Omit<React.ComponentProps<"section">, "title"> {
  /** The section heading, e.g. "Info". */
  title: React.ReactNode
}

/**
 * A labeled block of facts. The heading stays muted; the rows stack under
 * it with hairline separators.
 */
function AgentDetailsSection({
  title,
  className,
  children,
  ...props
}: AgentDetailsSectionProps) {
  return (
    <section
      data-slot="agent-details-section"
      className={cn("flex w-full min-w-0 flex-col gap-3", className)}
      {...props}
    >
      <h4 className="m-0 font-sans nessa-text-2 font-medium text-muted-foreground">
        {title}
      </h4>
      <div
        data-slot="agent-details-rows"
        className="flex w-full min-w-0 flex-col"
      >
        {children}
      </div>
    </section>
  )
}

export interface AgentDetailsProjectProps extends React.ComponentProps<"div"> {
  /** The repository or project path, e.g. `nessalabs/nessa_ui`. */
  path: React.ReactNode
  /** The branch or workspace under the path. */
  branch?: React.ReactNode
}

/**
 * The project identity at the top of the Info section: a path, and an
 * optional branch on the line under it. Separated from the key-value rows
 * so the path can read as a place rather than as another field.
 */
function AgentDetailsProject({
  path,
  branch,
  className,
  ...props
}: AgentDetailsProjectProps) {
  return (
    <div
      data-slot="agent-details-project"
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 border-b border-border pb-3",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate font-sans nessa-text-4 font-semibold text-foreground">
        {path}
      </span>
      {branch != null ? (
        <span className="min-w-0 truncate font-sans nessa-text-2 text-muted-foreground">
          {branch}
        </span>
      ) : null}
    </div>
  )
}

export interface AgentDetailsFieldProps extends React.ComponentProps<"div"> {
  /** The field name, left-aligned and muted. */
  label: React.ReactNode
  /** The field value, right-aligned. */
  value: React.ReactNode
}

/**
 * One key-value row in an Info section. The label stays muted; the value
 * takes the foreground so a scan of the right edge reads the facts.
 */
function AgentDetailsField({
  label,
  value,
  className,
  ...props
}: AgentDetailsFieldProps) {
  return (
    <div
      data-slot="agent-details-field"
      className={cn(
        "flex w-full min-w-0 items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0",
        className,
      )}
      {...props}
    >
      <span className="shrink-0 font-sans nessa-text-3 text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate text-end font-sans nessa-text-3 text-foreground">
        {value}
      </span>
    </div>
  )
}

export {
  AgentDetails,
  AgentDetailsAction,
  AgentDetailsActions,
  AgentDetailsField,
  AgentDetailsProject,
  AgentDetailsSection,
}
