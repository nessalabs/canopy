import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** A small icon-only button named by its tooltip, for board headers and the toolbar alike. */
export const IconButton = ({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-40 [&_svg]:size-4"
      >
        {children}
      </button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
)
