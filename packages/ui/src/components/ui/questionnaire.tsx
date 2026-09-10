import * as React from "react"

import { cn } from "@/lib/utils"

import { Button } from "./button"
import { Input } from "./input"

/**
 * Shared question identity between a `QuestionnaireItem` and the answer
 * controls composed inside it, so choices and the freeform input submit
 * under the item's field name without re-declaring it on every control.
 */
interface QuestionnaireItemContextValue {
  /** Field name answers in this item submit under. */
  name?: string
}

const QuestionnaireItemContext =
  React.createContext<QuestionnaireItemContextValue | null>(null)

/**
 * Selection state shared between a `QuestionnaireChoices` group and the
 * `QuestionnaireChoice` rows composed inside it.
 */
interface QuestionnaireChoicesContextValue {
  /** Group name wiring the native inputs together. */
  name: string
  /** Whether several choices may be selected at once. */
  multiple: boolean
  /** Whether the choice with this value is currently selected. */
  isSelected: (value: string) => boolean
  /** Applies a native input's checked change to the group value. */
  setSelected: (value: string, checked: boolean) => void
}

const QuestionnaireChoicesContext =
  React.createContext<QuestionnaireChoicesContextValue | null>(null)

/**
 * Reads the surrounding choices group's context.
 *
 * @param consumer - Component name used in the error when rendered outside a
 * `QuestionnaireChoices`.
 */
function useQuestionnaireChoices(consumer: string) {
  const context = React.useContext(QuestionnaireChoicesContext)
  if (!context) {
    throw new Error(`${consumer} must be used within a QuestionnaireChoices.`)
  }
  return context
}

export interface QuestionnaireProps extends React.ComponentProps<"div"> {}

/**
 * A composable question-flow surface for agent onboarding, feedback asks,
 * and structured intake. The root is a plain layout container: hosts stack a
 * `QuestionnaireHeader` (step counter, progress bar, or any custom chrome)
 * above one or more `QuestionnaireItem`s and keep ownership of navigation,
 * submission, and which question is visible.
 *
 * Inside an item, compose `QuestionnaireTitle` and `QuestionnaireDescription`
 * with the answer controls: `QuestionnaireChoices`/`QuestionnaireChoice` for
 * single or multiple selection (native radios and checkboxes under custom
 * indicators), and `QuestionnaireInput` for freeform text.
 */
function Questionnaire({ className, ...props }: QuestionnaireProps) {
  return (
    <div
      data-slot="questionnaire"
      className={cn(
        "flex w-full min-w-0 flex-col gap-5 font-sans text-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface QuestionnaireHeaderProps extends React.ComponentProps<"div"> {}

/**
 * The row above the questions. Drop a `QuestionnaireProgress` in it, or any
 * custom chrome — a title, a close button, a saved-state hint — and the row
 * spreads its children apart. A lone child sits at the inline start.
 */
function QuestionnaireHeader({ className, ...props }: QuestionnaireHeaderProps) {
  return (
    <div
      data-slot="questionnaire-header"
      className={cn(
        "flex min-h-5 items-center justify-between gap-3",
        className,
      )}
      {...props}
    />
  )
}

export interface QuestionnaireProgressProps
  extends React.ComponentProps<"div"> {
  /**
   * 1-based index of the question being answered; `0` renders an empty bar
   * for a not-yet-started flow. Clamped to `[0, total]`.
   */
  step: number
  /** Total number of questions. */
  total: number
  /**
   * How progress is drawn: `"counter"` renders the "Question 1 of 2" text,
   * `"bar"` renders a filled track sized to `step / total`.
   *
   * @default "counter"
   */
  variant?: "counter" | "bar"
  /**
   * Accessible name for the progress element, and the visible text of the
   * counter variant when provided (localized hosts pass their own copy).
   *
   * @default "Question <step> of <total>"
   */
  label?: string
}

/**
 * Batteries-included progress for the header: a "Question 1 of 2" counter or
 * a slim progress bar, both announcing position through a `progressbar`
 * role. Hosts wanting different chrome skip this component and compose their
 * own into `QuestionnaireHeader`.
 */
function QuestionnaireProgress({
  step,
  total,
  variant = "counter",
  label,
  className,
  ...props
}: QuestionnaireProgressProps) {
  const boundedTotal = Math.max(1, total)
  const boundedStep = Math.min(Math.max(0, step), boundedTotal)
  const progressLabel = label ?? `Question ${boundedStep} of ${boundedTotal}`
  const bar = variant === "bar"

  return (
    <div
      data-slot="questionnaire-progress"
      data-variant={variant}
      role="progressbar"
      aria-label={progressLabel}
      aria-valuemin={0}
      aria-valuemax={boundedTotal}
      aria-valuenow={boundedStep}
      className={cn(
        bar
          ? "h-1 w-full min-w-24 overflow-hidden rounded-full bg-border"
          : "nessa-text-2 font-medium tabular-nums text-muted-foreground",
        className,
      )}
      {...props}
    >
      {bar ? (
        <div
          data-slot="questionnaire-progress-fill"
          className="h-full rounded-full bg-primary transition-[width] [transition-duration:var(--nessa-motion-duration-normal)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none"
          style={{ width: `${(boundedStep / boundedTotal) * 100}%` }}
        />
      ) : (
        progressLabel
      )}
    </div>
  )
}

export interface QuestionnaireItemProps
  extends React.ComponentProps<"fieldset"> {
  /**
   * Field name the item's answers submit under. Provided to the choices
   * group and the freeform input through context, so a host form's
   * `FormData` picks the answers up without per-control wiring.
   */
  name?: string
}

/**
 * One question. Renders a `fieldset` so the title (a `legend`) names every
 * control inside it for assistive technology, and shares its `name` with the
 * answer controls composed within.
 */
function QuestionnaireItem({ name, className, ...props }: QuestionnaireItemProps) {
  const context = React.useMemo<QuestionnaireItemContextValue>(
    () => ({ name }),
    [name],
  )
  return (
    <QuestionnaireItemContext.Provider value={context}>
      <fieldset
        data-slot="questionnaire-item"
        className={cn(
          "m-0 flex min-w-0 flex-col gap-3 border-0 p-0",
          className,
        )}
        {...props}
      />
    </QuestionnaireItemContext.Provider>
  )
}

export interface QuestionnaireTitleProps
  extends React.ComponentProps<"legend"> {}

/**
 * The question prompt. A `legend`, so it labels the whole item's controls;
 * legends sit outside the fieldset's flex flow, which is why it carries its
 * own bottom margin instead of relying on the item gap.
 */
function QuestionnaireTitle({ className, ...props }: QuestionnaireTitleProps) {
  return (
    <legend
      data-slot="questionnaire-title"
      className={cn(
        "m-0 mb-1 p-0 nessa-text-5 font-medium text-foreground",
        className,
      )}
      {...props}
    />
  )
}

export interface QuestionnaireDescriptionProps
  extends React.ComponentProps<"p"> {}

/**
 * Supporting copy under the title — constraints, examples, why the question
 * is being asked.
 */
function QuestionnaireDescription({
  className,
  ...props
}: QuestionnaireDescriptionProps) {
  return (
    <p
      data-slot="questionnaire-description"
      className={cn("m-0 nessa-text-4 text-muted-foreground", className)}
      {...props}
    />
  )
}

export interface QuestionnaireChoicesProps
  extends Omit<React.ComponentProps<"div">, "defaultValue"> {
  /**
   * Whether several choices may be selected at once. Single selection uses
   * native radios (arrow keys move within the group); multiple selection
   * uses native checkboxes.
   *
   * @default false
   */
  multiple?: boolean
  /**
   * Group name for the native inputs and form submission. Falls back to the
   * surrounding `QuestionnaireItem` name, then to a generated id.
   */
  name?: string
  /** Selected choice values, when controlled. */
  value?: readonly string[]
  /** Initially selected choice values, when uncontrolled. */
  defaultValue?: readonly string[]
  /** Notified with the new selection after every toggle. */
  onValueChange?: (value: string[]) => void
}

/**
 * The answer options of one question. Owns the selection state — an array of
 * choice values in both modes, holding at most one entry unless `multiple` —
 * either uncontrolled via `defaultValue` or controlled via `value` +
 * `onValueChange`. Compose `QuestionnaireChoice` rows inside it, and a
 * `QuestionnaireInput` after them when the question also takes a freeform
 * answer.
 */
function QuestionnaireChoices({
  multiple = false,
  name,
  value,
  defaultValue,
  onValueChange,
  className,
  ...props
}: QuestionnaireChoicesProps) {
  const item = React.useContext(QuestionnaireItemContext)
  const generatedName = React.useId()
  const groupName = name ?? item?.name ?? generatedName

  const [uncontrolledValue, setUncontrolledValue] = React.useState<
    readonly string[]
  >(() => defaultValue ?? [])
  const rawSelected = value ?? uncontrolledValue
  // Single selection tolerates a multi-entry value by honoring the first,
  // so two radios in one native group can never both claim checked.
  const selected = React.useMemo(
    () => (multiple ? rawSelected : rawSelected.slice(0, 1)),
    [multiple, rawSelected],
  )

  const context = React.useMemo<QuestionnaireChoicesContextValue>(
    () => ({
      name: groupName,
      multiple,
      isSelected: (choice) => selected.includes(choice),
      setSelected: (choice, checked) => {
        const withoutChoice = selected.filter(
          (candidate) => candidate !== choice,
        )
        const next = checked
          ? multiple
            ? [...withoutChoice, choice]
            : [choice]
          : withoutChoice
        // A controlled group renders only what `value` says: the internal
        // state must not shadow-advance past a toggle the host rejects.
        if (value === undefined) setUncontrolledValue(next)
        onValueChange?.(next)
      },
    }),
    [groupName, multiple, selected, value, onValueChange],
  )

  return (
    <QuestionnaireChoicesContext.Provider value={context}>
      <div
        data-slot="questionnaire-choices"
        className={cn("flex flex-col gap-2", className)}
        {...props}
      />
    </QuestionnaireChoicesContext.Provider>
  )
}

export interface QuestionnaireChoiceProps
  extends React.ComponentProps<"label"> {
  /** Value this choice contributes to the group selection. */
  value: string
  /** Disables the choice without removing it from the list. */
  disabled?: boolean
  /**
   * Extra props forwarded to the underlying native input; its `className`
   * merges into the indicator classes rather than replacing them.
   */
  inputProps?: Omit<
    React.ComponentProps<"input">,
    "type" | "name" | "value" | "checked" | "onChange" | "disabled"
  >
}

/**
 * One selectable answer: a full-width label row wrapping a real radio or
 * checkbox (per the group's `multiple`), so clicks anywhere on the row
 * toggle it, keyboard and form semantics are native, and `FormData` sees the
 * answer under the group name. The indicator is the input itself — a rounded
 * square for checkboxes, a circle for radios — filling with a translucent
 * primary wash and a drawn check when selected.
 */
function QuestionnaireChoice({
  value,
  disabled,
  inputProps,
  className,
  children,
  ...props
}: QuestionnaireChoiceProps) {
  const { name, multiple, isSelected, setSelected } =
    useQuestionnaireChoices("QuestionnaireChoice")
  const { className: inputClassName, ...restInputProps } = inputProps ?? {}

  return (
    <label
      data-slot="questionnaire-choice"
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-border bg-transparent px-3 py-2.5 transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] select-none hover:border-ring/60 has-[:checked]:border-ring/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      <span
        data-slot="questionnaire-choice-indicator"
        className="relative mt-px inline-flex size-4.5 shrink-0 text-primary"
      >
        <input
          type={multiple ? "checkbox" : "radio"}
          name={name}
          value={value}
          checked={isSelected(value)}
          disabled={disabled}
          onChange={(event) => setSelected(value, event.target.checked)}
          className={cn(
            // The indicator's border is the only evidence an unselected
            // choice is there, so it carries a boundary-strength tone rather
            // than the fainter hairline used by fields that also have text.
            "peer m-0 size-full cursor-pointer appearance-none border border-muted-foreground bg-transparent shadow-xs outline-none transition-[border-color,background-color] [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] checked:border-primary checked:bg-primary/20 disabled:cursor-not-allowed motion-reduce:transition-none",
            "focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            multiple ? "rounded-xs" : "rounded-full",
            inputClassName,
          )}
          {...restInputProps}
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 18 18"
          data-slot="questionnaire-choice-check"
          className="pointer-events-none absolute inset-0 size-full opacity-0 transition-opacity [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] peer-checked:opacity-100 motion-reduce:transition-none"
        >
          <path
            d="M5.75 9.25L8 11.75L12.25 6.25"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </span>
      <span
        data-slot="questionnaire-choice-label"
        className="min-w-0 flex-1 nessa-text-4 text-foreground"
      >
        {children}
      </span>
    </label>
  )
}

export interface QuestionnaireInputProps
  extends React.ComponentProps<typeof Input> {}

/**
 * Freeform text answer. The library `Input` wired to the surrounding item's
 * field name; compose it alone under a title or after fixed choices for an
 * "other" style answer — and give it its own `name` in that combination,
 * or the freeform text and the checked choices submit under the same
 * `FormData` key. The item legend names the group, not this control — give
 * the input its own accessible name (`aria-label` or a visible label),
 * placeholders don't substitute.
 */
function QuestionnaireInput({ name, ...props }: QuestionnaireInputProps) {
  const item = React.useContext(QuestionnaireItemContext)
  return (
    <Input
      data-slot="questionnaire-input"
      name={name ?? item?.name}
      {...props}
    />
  )
}

export interface QuestionnaireActionsProps extends React.ComponentProps<"div"> {}

/**
 * The row below the questions holding navigation and submission controls —
 * a Back button, a Continue button, a `QuestionnaireSubmit`. Mirrors the
 * header row: children spread apart, so a lone submit sits at the inline
 * end and a Back/Continue pair spans the row.
 */
function QuestionnaireActions({
  className,
  ...props
}: QuestionnaireActionsProps) {
  return (
    <div
      data-slot="questionnaire-actions"
      className={cn("flex items-center justify-end gap-2", className)}
      {...props}
    />
  )
}

export interface QuestionnaireSubmitProps
  extends React.ComponentProps<typeof Button> {}

/**
 * The submit control: the library `Button` defaulting to `type="submit"`,
 * so wrapping the questionnaire in a `<form>` submits every item's answers
 * as `FormData` under their field names. Children default to "Submit";
 * pass your own copy ("Finish", "Send feedback") or any Button prop.
 */
function QuestionnaireSubmit({
  type = "submit",
  children,
  ...props
}: QuestionnaireSubmitProps) {
  return (
    <Button data-slot="questionnaire-submit" type={type} {...props}>
      {children ?? "Submit"}
    </Button>
  )
}

export {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireHeader,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
}
