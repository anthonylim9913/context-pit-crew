// carried: kept from an earlier reading that the latest one left out, so it is drawn only until its reset time.
export type Meter = { percent: number; resetsAt?: string; carried?: boolean }

export type Snapshot = {
  // estimated: worked out from the compaction's own count until the next measurement replaces it.
  context?: { percent: number; tokens: number; window: number; estimated?: boolean }
  fiveHour?: Meter
  weekly?: Meter
  usd?: number
  measuredAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-pit-crew': {
      snapshot: Snapshot | null
      warned: string[]
      lastReplyAt: number | null
      tick: number
      nudged: number[]
      compactions: number
      justCompacted: boolean
      checkPending: boolean
      pendingSince: number | null
      compactPlan: string | null
      compactingSince: number | null
      autoCheck: boolean
      autoAt: number | null
      autoFired: boolean
      autoWaiting: boolean
      handoffPending: boolean
      handedOff: { name: string; at: number; announced: boolean } | null
      lastNote: { text: string; tone: string; at: number } | null
      dismissedStatus: string | null
      handoffHint: { reason: string; at: number } | null
      hintReasons: string[]
      paneFocus: 'context' | 'limits'
    }
  }
}
