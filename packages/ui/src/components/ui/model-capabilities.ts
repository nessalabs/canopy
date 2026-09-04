export interface ModelThinkingLevel {
  value: string
  label: string
  description?: string
  /**
   * Opts this level into the order-independent Ultra launch treatment. Ordered
   * levels build ambient stream tension progressively; Ultra overrides that
   * ordinal energy with maximum speed, contrast, and transition force. Motion
   * is omitted whenever the user prefers reduced motion.
   */
  accent?: "ultra"
}

/** Describes capability data that consumers can join to a selected model. */
export interface ModelCapabilities {
  fastMode?: boolean
  thinking?: ModelThinkingLevel[]
  defaultThinking?: string
}
