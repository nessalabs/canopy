import { randomUUID } from 'node:crypto'

export const newId = (): string => randomUUID()
export const now = (): number => Date.now()
