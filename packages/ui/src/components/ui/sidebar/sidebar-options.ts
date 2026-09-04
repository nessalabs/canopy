const SidebarSide = Object.freeze({
  Left: "left",
  Right: "right",
} as const)

/** A supported physical edge for the Sidebar shell. */
type SidebarSide = (typeof SidebarSide)[keyof typeof SidebarSide]

/** Visual shell presentations supported by Sidebar. */
const SidebarVariant = Object.freeze({
  Sidebar: "sidebar",
  Floating: "floating",
  Inset: "inset",
} as const)

/** A supported visual relationship between Sidebar and application content. */
type SidebarVariant = (typeof SidebarVariant)[keyof typeof SidebarVariant]

/** Collapse behaviors supported by Sidebar. */
const SidebarCollapsible = Object.freeze({
  Offcanvas: "offcanvas",
  Icon: "icon",
  None: "none",
} as const)

/** A supported behavior for presenting a collapsed Sidebar. */
type SidebarCollapsible =
  (typeof SidebarCollapsible)[keyof typeof SidebarCollapsible]

export {
  SidebarCollapsible,
  SidebarSide,
  SidebarVariant,
}
