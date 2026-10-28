import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, PromptSubmitArgs, Register, RenderChildren, SelectOption, SessionUsage } from 'claude-code'

import type { Meter, Snapshot } from '../types'

const PANE = 'context-pit-crew'
const TITLE = 'Usage'
const WARN_AT = [75, 90]
const BAR_WIDTH = 20
const MINI_BAR = 10
// The band's SVG bar, in points: half 28o's 64, so Context, 5h, Week, Cache and Cost fit one line in a band measured
// at about 710 points inside (2026-10-28); the number beside it carries the exact figure.
const BAND_BAR = 32

// The manifest's userConfig, set by register (a reload runs it again). The cache lifetime and the context lines suit an
// account and a habit, so they are options; the engine reports no cache lifetime for the session (only a model switch carries one).
type Config = {
  diagnostics: boolean
  openPaneOnStart: boolean
  cacheTtlMs: number
  coldWarningMs: number
  // Context percent lines: watch, state page, compact zone, overdue.
  ctxWatch: number
  ctxStatePage: number
  ctxCompact: number
  ctxOverdue: number
}
function configFrom(o: PluginOptions): Config {
  const num = (key: string, fallback: number) => (typeof o[key] === 'number' && Number.isFinite(o[key]) ? (o[key] as number) : fallback)
  const asked = { watch: num('contextWatch', 40), statePage: num('contextStatePage', 50), compact: num('contextCompact', 60), overdue: num('contextOverdue', 75) }
  // Out of order, the lines would swallow each other: fall back to the defaults together.
  const ordered = 0 < asked.watch && asked.watch < asked.statePage && asked.statePage < asked.compact && asked.compact < asked.overdue && asked.overdue <= 100
  const lines = ordered ? asked : { watch: 40, statePage: 50, compact: 60, overdue: 75 }
  // A reply after the cache lifetime re-writes the whole context.
  const cacheTtlMs = Math.max(1, num('cacheTtlMinutes', 60)) * 60 * 1000
  return {
    diagnostics: o.diagnostics === true,
    openPaneOnStart: o.openPaneOnStart === true,
    cacheTtlMs,
    // Whole minutes, so the toast's "in N min" is never more than what is left.
    coldWarningMs: Math.max(1, Math.min(5, Math.floor(cacheTtlMs / 120000))) * 60 * 1000,
    ctxWatch: lines.watch,
    ctxStatePage: lines.statePage,
    ctxCompact: lines.compact,
    ctxOverdue: lines.overdue,
  }
}
let cfg: Config = configFrom({})
// Claude's own suggestion that the work move to a fresh session; the user decides with the New session button.
const SUGGEST_TOOL = 'suggest_new_session'
const SUGGEST_LINE =
  `If the work has moved to a topic unrelated to what this session began with, a fresh session beats compacting: ` +
  `call the ${SUGGEST_TOOL} tool with the reason (it only suggests; the user decides).`
// The one compact control, named exactly as the band draws it.
const CHECK_NAME = 'Check & compact'
// The note Claude gets when context first crosses a line. Each one yields to the user's own request, and none creates a file unasked.
function nudge(level: number, pct: number): string {
  if (level === cfg.ctxStatePage)
    return (
      `[Context Pit Crew] Context is at ${pct}%. Do what the user asks first. If this session keeps a start-here state page, ` +
      `refresh it once the current step is done (every running background task and what to do when it finishes) and say so in one line. ` +
      `If it keeps none, do not create one unasked: offer to, and ask where it should live.`
    )
  if (level === cfg.ctxCompact)
    return (
      `[Context Pit Crew] Context is at ${pct}%. Do what the user asks first. When a turn ends at a good spot (nothing half-done, ` +
      `no unanswered approval, background work notifies on its own), tell the user in one line that it is a good time to press ` +
      `${CHECK_NAME} in the Context Pit Crew band. You cannot compact yourself. ${SUGGEST_LINE}`
    )
  return (
    `[Context Pit Crew] Context is at ${pct}%, past the overdue line. Do what the user asks; before starting long multi-step work, ` +
    `say in one line that context is high and suggest pressing ${CHECK_NAME} first.`
  )
}
// Marks the plan the mod hands /compact, so its own compactions are told apart from the host's and the user's.
const PLAN_MARK = '(Context Pit Crew plan)'
const KEEP_LINE =
  'Keep: the path of the start-here state page, if this session has one; ' +
  'pending user decisions word for word; running background task IDs and what each is; the exact next step. ' +
  'Drop: file contents and tool output already captured on the state page.'
const AFTER_COMPACT =
  '[Context Pit Crew] The conversation was compacted at a spot the pre-compaction check confirmed. Answer the user\'s message first. ' +
  'If it continues the earlier work, read the state page the summary names (if there is one) and check the background tasks it lists ' +
  'before acting. Do not re-read files to rebuild what the page states.'

// Prompt origins that are not the user's own words. A closed list of those, not of the user's origins: a typed prompt
// the desktop stamps another way still gets the notes, where a list of the user's would silence them.
const NOT_YOUR_WORDS: ReadonlySet<string> = new Set([
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity',
])

const snapshot = atom({ plugin: 'context-pit-crew', key: 'snapshot' } as const, null)
const warned = atom({ plugin: 'context-pit-crew', key: 'warned' } as const, [])
const lastReplyAt = atom({ plugin: 'context-pit-crew', key: 'lastReplyAt' } as const, null)
const tick = atom({ plugin: 'context-pit-crew', key: 'tick' } as const, 0)
const nudged = atom({ plugin: 'context-pit-crew', key: 'nudged' } as const, [])
const compactions = atom({ plugin: 'context-pit-crew', key: 'compactions' } as const, 0)
const justCompacted = atom({ plugin: 'context-pit-crew', key: 'justCompacted' } as const, false)
const checkPending = atom({ plugin: 'context-pit-crew', key: 'checkPending' } as const, false)
// When the running check or handoff started: atoms outlive a reload and module timers do not, so a stale one is still found and ended.
const pendingSince = atom({ plugin: 'context-pit-crew', key: 'pendingSince' } as const, null)
const compactPlan = atom({ plugin: 'context-pit-crew', key: 'compactPlan' } as const, null)
// Set while the mod's own compaction is queued or retrying, so a second press or a second turn end cannot start another.
const compactingSince = atom({ plugin: 'context-pit-crew', key: 'compactingSince' } as const, null)
const autoCheck = atom({ plugin: 'context-pit-crew', key: 'autoCheck' } as const, false)
// The context percent Auto runs at; null follows the contextCompact option. The Auto menu picks it, /pit-crew auto N sets it.
const autoAt = atom({ plugin: 'context-pit-crew', key: 'autoAt' } as const, null as number | null)
const AUTO_STEPS = [50, 60, 70, 80]
async function autoLevel($: EngineInterface): Promise<number> {
  return (await read($, autoAt)) ?? cfg.ctxCompact
}
async function setAuto($: EngineInterface, turnOn: boolean) {
  await update($, autoCheck, () => turnOn)
  await $.store.set('autoCheck', turnOn)
}
// A level Auto can run at and keep across a restart. Any level the menu lists passes, the contextCompact option's
// included (a fraction such as 62.5 too), so every option shown can be picked; the command takes whole levels only.
function autoLevelOk(at: number): boolean {
  return Number.isFinite(at) && at > 0 && at < 100
}
async function setAutoLevel($: EngineInterface, at: number) {
  await update($, autoAt, () => at)
  await $.store.set('autoAt', at)
}
// Auto's menu, as the footer's effort menu lists its levels: Off, then the levels in order. A level set another way
// (/pit-crew auto N, or the contextCompact option) is listed in its place, so the current one is always there.
function autoOptions(level: number): SelectOption[] {
  const levels = AUTO_STEPS.includes(level) ? AUTO_STEPS : [...AUTO_STEPS, level].sort((a, b) => a - b)
  return [{ value: 'off', label: 'Off' }, ...levels.map(n => ({ value: String(n), label: `${n}%` }))]
}
// A pick from Auto's menu: Off turns it off, a level turns it on at that level. The note spells it as the band draws it.
async function pickAuto($: EngineInterface, picked: string) {
  if (picked === 'off') {
    await setAuto($, false)
    await say($, 'Auto Off.', 'suggestion')
    return
  }
  const at = Number(picked)
  if (!autoLevelOk(at)) return
  await setAutoLevel($, at)
  await setAuto($, true)
  await say($, `Auto ${at}%. The check runs once a turn ends past ${at}% context.`, 'suggestion')
}
// A surface that draws no menu (the mobile app) gets a plain Auto button instead: each press picks the option after the
// current one, and past the last turns Auto off. It reads the atoms, not the level drawn before the press.
async function stepAuto($: EngineInterface) {
  const at = await autoLevel($)
  const options = autoOptions(at)
  const current = (await read($, autoCheck)) ? String(at) : 'off'
  const i = options.findIndex(o => o.value === current)
  await pickAuto($, options[(i + 1) % options.length]?.value ?? 'off')
}
const autoFired = atom({ plugin: 'context-pit-crew', key: 'autoFired' } as const, false)
// Auto's short wait before it starts a check. An atom, so a reload that killed the timer still finds it and gives the run back.
const autoWaiting = atom({ plugin: 'context-pit-crew', key: 'autoWaiting' } as const, false)
const handoffPending = atom({ plugin: 'context-pit-crew', key: 'handoffPending' } as const, false)
// The proposed new session, shown for NOTE_FOR_MS and cleared by a typed prompt or a compaction.
const handedOff = atom({ plugin: 'context-pit-crew', key: 'handedOff' } as const, null)
// The last thing a button or a compaction did, shown under the buttons for a few minutes.
const lastNote = atom({ plugin: 'context-pit-crew', key: 'lastNote' } as const, null)
// The status text you dismissed: the line stays hidden until the text changes, a compaction, or a /clear.
const dismissedStatus = atom({ plugin: 'context-pit-crew', key: 'dismissedStatus' } as const, null)
// Claude's suggestion to hand off, until you start a handoff, compact, or dismiss it.
const handoffHint = atom({ plugin: 'context-pit-crew', key: 'handoffHint' } as const, null)
// Every reason Claude has suggested this conversation, so the same one is never raised twice.
const hintReasons = atom({ plugin: 'context-pit-crew', key: 'hintReasons' } as const, [])
// Which section the Usage pane puts first: the one whose meter label was clicked.
const paneFocus = atom({ plugin: 'context-pit-crew', key: 'paneFocus' } as const, 'context')
// The labels are plain Buttons. The engine says a desktop draws a native button either way, but seen live (2026-10-28)
// a plain one draws as text that greys under the pointer. Each control's short tip floats in a card just above it while the pointer is on it (a
// hover reveal of an absolutely placed card inside the control's keyed Box, so nothing reflows); the full text is in
// /pit-crew help, since hovers reach pointer surfaces only.
type TipId = 'check' | 'handoff' | 'refresh' | 'auto'
const TIP_IDS: readonly TipId[] = ['check', 'handoff', 'refresh', 'auto']
const TIPS: Record<Exclude<TipId, 'auto'>, string> = {
  check: 'Claude checks this is a safe spot (nothing half-done or waiting on you), refreshes the state page if the session keeps one, then compacts. One model turn over the whole context. While a confirmed plan waits, a press compacts it at once.',
  handoff: 'Claude checks for a safe spot, updates the state page (or the project docs, when the project uses project-docs-protocol), writes a short brief, and offers a "Continue:" card that starts a fresh session in this folder. One model turn over the whole context.',
  refresh: 'Re-reads the context and limit figures and reloads the mods (/reload-plugins).',
}
function shortTip(id: TipId, level: number): string {
  return id === 'check' ? 'Claude checks it is safe, then compacts'
    : id === 'handoff' ? 'Brief + a card for a fresh session'
    : id === 'refresh' ? 'Re-read figures, reload the mods'
    : `Runs Check & compact itself past ${level}%`
}
function tipText(id: TipId, level: number): string {
  return id === 'auto'
    ? `When on, the safe-spot check runs by itself once a turn ends past ${level}% context, at most once between compactions. ` +
        'After two compactions it runs the New session handoff instead. Each run is a model turn you did not type. ' +
        `Pick Off or a level from its menu (${AUTO_STEPS.join(', ')}%); /pit-crew auto N sets any level. ` +
        'Where the band draws no menu (the mobile app), each press steps to the next level, then Off.'
    : TIPS[id]
}
const BUTTON_NAMES: Record<TipId, string> = { check: CHECK_NAME, handoff: 'New session', refresh: 'Refresh', auto: 'Auto' }
// The hover tips reach pointer surfaces only, so the command's help repeats them.
function helpText(level: number): string {
  return ['Buttons in the band above the prompt:', ...TIP_IDS.map(id => `${BUTTON_NAMES[id]}: ${tipText(id, level)}`)].join('\n')
}
const NOTE_FOR_MS = 10 * 60 * 1000

// The prompts lean on two kinds of skill a session may not have (a context or compaction skill the user set up, and
// project-docs-protocol; the mods can be installed anywhere), so each step stands on its own. No skill is named here
// that a stranger would not have.
// A project that already uses project-docs-protocol is kept in its own format; nothing here offers or installs it.
const DOCS_PROTOCOL_RELEASE = 'v0.4.1'
const SKILLS_NOTE =
  'If the user has set up a skill for managing context, compaction or handoffs and this session has it, follow it too; ' +
  'the steps below are complete without it.\n'
const STATE_PAGE_NOTE =
  'Which page: if the project carries the project-docs-protocol signature (STATUS.md, CHANGELOG.md and DECISIONS.md at the root or under docs/, ' +
  'plus the "## Project docs protocol" block in CLAUDE.md or AGENTS.md or the line "Installed via the `project-docs-protocol` skill" in the docs README) ' +
  "and this session has the project-docs-protocol skill, run its Close and let STATUS cite the page. If the project carries the signature but the skill is missing, " +
  `or is older than release ${DOCS_PROTOCOL_RELEASE}, do not imitate its Close from memory: update CHANGELOG.md (newest entry at the top) and STATUS.md by hand ` +
  'as the docs README describes. ' +
  'Without the signature, use the state page this session already keeps (the one the last checkpoint named). ' +
  'If it keeps none, do not create one unasked: say so in one line, and carry the pending questions and the next step ' +
  'in the ready_to_compact call (a check) or in the brief (a handoff) instead.'
// A half-done step is parked, never finished, so a check or handoff runs no work the user did not ask for.
const PARK_LINE =
  'If a step is half-done, park it: write a note of where it stands (on the state page, or in your reply if there is none); do not finish it. ' +
  `If parking needs more than a note, or an approval or decision is waiting on me, call the not_safe_to_compact tool with the reason first, then ask it.`

// The pre-compaction check: Claude tests for a good spot, and only a pass calls the tool that lets the mod compact.
const READY_TOOL = 'ready_to_compact'
// A failed check says so at once, so the band stops showing a running check.
const NOT_SAFE_TOOL = 'not_safe_to_compact'
// How a prompt opens when the Auto setting started it: nobody pressed anything, and the user's "I" and "me" still apply below.
const autoOpening = (what: string, level: number) =>
  `${what} (started by the Context Pit Crew Auto setting because context passed ${level}%; the user pressed nothing, and "I" and "me" below mean the user). `
// Who asked: a press, the /pit-crew command, or the Auto setting; each prompt says which, so none claims a press that did not happen.
type Source = 'button' | 'command' | 'auto'
const HALF_DONE = 'nothing is half-done (a step parked with a note, as below, counts as done)'
const checkPrompt = (source: Source, level: number) =>
  (source === 'auto'
    ? autoOpening('Pre-compaction check', level)
    : `Pre-compaction check (the user ${source === 'button' ? `pressed ${CHECK_NAME} in the Context Pit Crew band` : 'ran /pit-crew check'}; "I" and "me" below mean the user). `) +
  SKILLS_NOTE +
  `1. Test the four good-spot conditions: ${HALF_DONE}; no question is waiting on me (an unanswered approval always blocks); ` +
  'background work runs on its own and will notify; the state page, if this session keeps one, is current.\n' +
  `2. ${PARK_LINE}\n` +
  '3. If this session keeps a start-here state page, refresh it (overwrite, do not append): every running background task with its ID and what to do when it lands, ' +
  'pending questions word for word, standing rules, and the exact next step. Reread it once as a stranger would. ' +
  STATE_PAGE_NOTE +
  '\n' +
  `4. If all four conditions hold, call the ${READY_TOOL} tool with the state page path (or "none") and the live items, then end with one line. ` +
  `If they do not, do not call it: call the ${NOT_SAFE_TOOL} tool with a one-line reason, then say in two or three lines what blocks compaction and what would make it safe.`

// The handoff: the same safe-spot test, then a fresh session that starts from the state page instead of this transcript.
const HANDOFF_TOOL = 'ready_to_hand_off'
const handoffPrompt = (source: Source, level: number) =>
  (source === 'auto'
    ? autoOpening('Hand this work off to a fresh session', level) + 'Context has also been compacted twice already. '
    : `Hand this work off to a fresh session (I ${source === 'button' ? 'pressed New session in the Context Pit Crew band' : 'ran /pit-crew handoff'}). `) +
  SKILLS_NOTE +
  `1. Test the four good-spot conditions: ${HALF_DONE}; no question is waiting on me (an unanswered approval always blocks); ` +
  'background work runs on its own and will notify; the state page, if this session keeps one, is current. ' +
  `${PARK_LINE}\n` +
  '2. If this session keeps a start-here state page, refresh it (overwrite, do not append): ' +
  'every running background task with its ID and what to do when it lands, pending questions word for word, standing rules, the exact next step. ' +
  'Reread it once as a stranger would. ' +
  STATE_PAGE_NOTE +
  '\n' +
  '3. Write the handoff brief: under 150 words, ' +
  'its first line naming the state page to read first (if there is one), then what is running, what waits on me, and the next step. ' +
  "In a project-docs-protocol project, tell the new session to run that skill's Bootstrap, or to read STATUS.md first if it lacks the skill.\n" +
  // The app starts a session only on words the user typed; a prompt a plugin submits, even in the user's name, is refused "user_asked".
  '4. If every condition holds, propose the new session with mcp__ccd_session__start_session: initiation "own_initiative" (the app starts a session ' +
  'only on words typed in the prompt box, and refuses "user_asked" for a prompt a plugin submits, so the request goes through a card I click), context "fresh", ' +
  'use_worktree false (so it continues in this same folder and branch), the brief as `prompt`, two or three sentences of goal and constraints as `background`, ' +
  'and a title starting "Continue:". ' +
  `Then call the ${HANDOFF_TOOL} tool with the card's title and end with one line: click the card to start the new session, and do not archive this one while the new one works in its folder. ` +
  `Outside the desktop app (no start_session tool), print the brief in one copyable block instead, call ${HANDOFF_TOOL} with new_session "brief printed", ` +
  'and end with one line: paste the brief into a new session in this folder. ' +
  `If any condition fails, start nothing and do not call ${HANDOFF_TOOL}: call the ${NOT_SAFE_TOOL} tool with a one-line reason, then say in two or three lines what blocks the handoff and what would make it safe.`

function toSnapshot(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>, now: number): Snapshot {
  const meter = (kind: string): Meter | undefined => {
    const w = u.rateLimits.find(r => r.kind === kind)
    return w ? { percent: w.percentUsed, resetsAt: w.resetsAt } : undefined
  }
  const c = u.context
  return {
    context:
      c.percent === undefined
        ? undefined
        : { percent: c.percent, tokens: c.tokens ?? 0, window: c.window },
    fiveHour: meter('five_hour'),
    weekly: meter('seven_day'),
    usd: u.cost?.usd,
    measuredAt: now,
  }
}

function filled(percent: number, width: number): number {
  return Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
}

// A terminal bar in block characters: the filled part takes the meter's tone, the rest is a subtle track.
function bar(percent: number, width: number): { fill: string; track: string } {
  const n = filled(percent, width)
  return { fill: '█'.repeat(n), track: '░'.repeat(width - n) }
}

// Theme tones as colours an SVG can carry. The blue is the desktop's own context ring (sampled from a screenshot,
// 2026-10-28) and the orange is Claude's working mark; the track is a translucent grey that reads on light and dark themes.
const TONE_HEX: Record<string, string> = { success: '#4ade80', suggestion: '#407bd9', warning: '#fbbf24', error: '#f87171', claude: '#d97757' }

// An exact bar: a rounded track and a fill whose width is the percentage, so 50% is visibly half at a glance.
function svgBar(percent: number, toneName: string, width: number, height: number): string {
  const w = Math.max(0, Math.min(width, (percent / 100) * width))
  const r = height / 2
  const colour = TONE_HEX[toneName] ?? TONE_HEX.suggestion
  // Ids are document-wide once the drawings sit inline: key the clip to the size it clips, so bars of different sizes never share one.
  const clip = `um-bar-clip-${width}x${height}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><clipPath id="${clip}"><rect width="${width}" height="${height}" rx="${r}"/></clipPath></defs>` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="#8a8a8a" fill-opacity="0.28"/>` +
    `<rect width="${w.toFixed(1)}" height="${height}" fill="${colour}" clip-path="url(#${clip})"/>` +
    `</svg>`
  )
}

// The running mark: Claude's orange spark, turning and pulsing. SMIL animates it on the desktop without redrawing the band.
const SPARK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"><g fill="${TONE_HEX.claude}">` +
  [0, 45, 90, 135].map(a => `<rect x="10.5" y="2" width="3" height="20" rx="1.5" transform="rotate(${a} 12 12)"/>`).join('') +
  '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="2.4s" repeatCount="indefinite"/>' +
  '<animate attributeName="opacity" values="1;0.45;1" dur="1.2s" repeatCount="indefinite"/></g></svg>'

// The running status line, glowing as Claude's own text does while it works: a light band sweeps across the words.
// Drawn as SVG so SMIL animates it without redrawing the band. It is set at the band's caption size (about 11.5px),
// as the status line's text is when Claude is not at work, so the line keeps its size when it starts or stops glowing.
const GLOW_FONT = 11.5
const GLOW_HEIGHT = 16
// The text's width in the system font, from rough per-glyph widths. The SVG then stretches the text to exactly
// this width (textLength), so a wrong guess moves letter spacing a little instead of leaving a gap before the ×.
function glowTextWidth(text: string): number {
  let em = 0
  for (const c of text) {
    em += /[ijl.,:;'|!]/.test(c) ? 0.26 : /[ftr ]/.test(c) ? 0.33 : /[mwMW…]/.test(c) ? 0.85 : /[A-Z]/.test(c) ? 0.64 : /[0-9]/.test(c) ? 0.58 : 0.53
  }
  return Math.ceil(em * GLOW_FONT)
}
function glowWidth(text: string): number {
  return glowTextWidth(text) + 8
}
function glowSvg(text: string, toneName: string): string {
  const w = glowWidth(text)
  const colour = TONE_HEX[toneName] ?? TONE_HEX.suggestion
  const grad = `um-glow-${w}-${toneName.replace(/\W/g, '')}`
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${GLOW_HEIGHT}" viewBox="0 0 ${w} ${GLOW_HEIGHT}">` +
    `<defs><linearGradient id="${grad}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">` +
    `<stop offset="0" stop-color="${colour}"/><stop offset="0.42" stop-color="${colour}"/>` +
    `<stop offset="0.5" stop-color="#ffffff"/>` +
    `<stop offset="0.58" stop-color="${colour}"/><stop offset="1" stop-color="${colour}"/>` +
    `<animateTransform attributeName="gradientTransform" type="translate" from="${-w} 0" to="${w} 0" dur="2s" repeatCount="indefinite"/>` +
    `</linearGradient></defs>` +
    `<text x="4" y="12" font-family="-apple-system, system-ui, sans-serif" font-size="${GLOW_FONT}" textLength="${glowTextWidth(text)}" lengthAdjust="spacing" fill="url(#${grad})">${safe}</text></svg>`
  )
}

// A meter's tone, as Claude Code colours its own context ring: the app's blue while normal, amber past the warning
// line, red past the limit. Claude's orange is kept for "Claude is working" alone.
type Tone = 'suggestion' | 'warning' | 'error'
function tone(percent: number): Tone {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'suggestion'
}

function ctxTone(percent: number): Tone {
  return percent >= cfg.ctxOverdue ? 'error' : percent >= cfg.ctxCompact ? 'warning' : 'suggestion'
}

// A value (a percent, a cost, the cache minutes) is normal text while its meter is normal, and takes the tone once it warns.
function valueTone(t: string): string | undefined {
  return t === 'suggestion' ? undefined : t
}

// The cache estimate's tone: blue while warm, amber in the last minutes before it likely goes cold, red once it likely has.
function cacheTone(left: number): Tone {
  return left <= 0 ? 'error' : left <= cfg.coldWarningMs ? 'warning' : 'suggestion'
}

function ctxAdvice(percent: number, compacted: number): string {
  if (percent >= cfg.ctxOverdue) return 'overdue: park the current step and compact'
  if (percent >= cfg.ctxCompact) return compacted >= 2 ? 'compacted twice already: prefer a fresh session' : 'compact at the next good spot'
  if (percent >= cfg.ctxStatePage) return 'refresh the state page'
  if (percent >= cfg.ctxWatch) return 'watch for the next good spot'
  return ''
}

function untilReset(resetsAt: string | undefined, now: number, short = false): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return 'resetting'
  const mins = Math.round(ms / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const span = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
  return short ? span : `resets in ${span}`
}

function kTokens(n: number): string {
  // Rounded first, so 999,600 reads "1M", not "1000k".
  if (Math.round(n / 1000) >= 1000) return `${Number((n / 1000000).toFixed(1))}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

function statusText(s: Snapshot, now: number): string | undefined {
  const parts: string[] = []
  const fiveHour = drawn(s.fiveHour, now)
  const weekly = drawn(s.weekly, now)
  if (s.context) parts.push(`ctx ${Math.round(s.context.percent)}%`)
  if (fiveHour) parts.push(`5h ${Math.round(fiveHour.percent)}%`)
  if (weekly) parts.push(`wk ${Math.round(weekly.percent)}%`)
  if (s.usd !== undefined) parts.push(`$${s.usd.toFixed(2)}`)
  return parts.length ? parts.join(' · ') : undefined
}

function cacheLeft(at: number | null, now: number): number | undefined {
  return at === null ? undefined : at + cfg.cacheTtlMs - now
}

// Once the band above the prompt draws the meter, the plain status text would repeat it.
let bandDrawn = false

// A limit window the last snapshot had, kept while a reading leaves it out: one reading without it must not hide its
// meter. It keeps its own figures and reset time, so nothing about it reads as newly measured, and once that reset
// time has passed with no reading of it, it goes. A window with no reset time cannot be dated, so it is not kept.
function stillOpen(m: Meter | undefined, now: number): Meter | undefined {
  const ends = m?.resetsAt === undefined ? NaN : Date.parse(m.resetsAt)
  return ends > now ? m : undefined
}
function carriedOver(m: Meter | undefined, now: number): Meter | undefined {
  const kept = stillOpen(m, now)
  return kept && { ...kept, carried: true }
}
// A window as it is drawn now: a carried one goes at its reset time even when no reading comes after it, so the band,
// the pane and the status text never show it past that time. A window the latest reading has is drawn as read (past
// its reset time it reads "resetting" until the next reading), as before carry-over.
function drawn(m: Meter | undefined, now: number): Meter | undefined {
  return m?.carried ? stillOpen(m, now) : m
}

async function record($: EngineInterface, reading: Snapshot) {
  const prev = await read($, snapshot)
  const s: Snapshot = {
    ...reading,
    fiveHour: reading.fiveHour ?? carriedOver(prev?.fiveHour, reading.measuredAt),
    weekly: reading.weekly ?? carriedOver(prev?.weekly, reading.measuredAt),
  }
  await update($, snapshot, () => s)
  if (!bandDrawn) $.ui.status(statusText(s, s.measuredAt))

  const rows: [string, number | undefined][] = [
    ['Context', s.context?.percent],
    ['5-hour limit', s.fiveHour?.percent],
    ['Weekly limit', s.weekly?.percent],
  ]
  const seen = await read($, warned)
  const fresh: string[] = []
  for (const [name, pct] of rows) {
    if (pct === undefined) continue
    const crossed = WARN_AT.filter(at => pct >= at && !seen.includes(`${name}:${at}`))
    if (!crossed.length) continue
    // Every line crossed is recorded, but one reading raises one toast per meter: a session that starts at 92% gets one, not two.
    fresh.push(...crossed.map(at => `${name}:${at}`))
    $.ui.toast(`${name} at ${Math.round(pct)}%`, { timeoutMs: 8000 })
  }
  // Forget a warning once its window drops back (a reset or a compaction), so it can fire again.
  const kept = seen.filter(key => {
    const [name, at] = key.split(':')
    const pct = rows.find(r => r[0] === name)?.[1]
    return pct !== undefined && pct >= Number(at)
  })
  if (fresh.length || kept.length !== seen.length) {
    await update($, warned, () => [...kept, ...fresh])
  }
  // Context back under the watch line (a compaction, a /clear): the budget nudges, and Auto, may fire again.
  if (s.context && s.context.percent < cfg.ctxWatch) {
    await update($, nudged, () => [])
    await update($, autoFired, () => false)
  }
}

// Module timers and turn state; a reload cancels the timers with the old environment, and the atoms carry the rest.
let coldWarning: { cancel: () => void } | undefined
let ticker: { cancel: () => void } | undefined
let checkTimer: { cancel: () => void } | undefined
// The band's isWorking as last drawn. The desktop raises no turn.complete for mods, so its fall is how a turn's end is seen there.
let working = false
// Whether the running check's own prompt has been submitted, so the end of that turn (not an earlier one) can end the check.
let checkTurnStarted = false
// Why the last turn ended, where the engine says so (turn.complete reaches the terminal only); reset when a prompt is sent.
let lastTurnReason: string | undefined
// Counts compactions the session.compact hook saw, so a /compact that never ran is told apart from one that did.
let compactSeq = 0
// The plan a measurement already scheduled, so several measurements in a row schedule it once.
let planScheduled: string | undefined
// The plan whose compaction ran out of retries: the band says so until a press or a compaction.
let gaveUp: string | undefined
// Auto's short wait before it starts, cancelled by a /clear or a typed message.
let autoTimer: { cancel: () => void } | undefined
const CHECK_TIMEOUT_MS = 10 * 60 * 1000
const COMPACT_TIMEOUT_MS = 3 * 60 * 1000

// Breadcrumbs so a failure in a live session can be read back later, written only when the diagnostics option is on.
// The store file is shared by every session and each writes its whole copy back, so breadcrumbs go to a per-session temp file.
// They record that something happened and when, never text Claude wrote.
const BUILD = '2026-10-28p'
const DIAG_DIR = '/tmp/claude-mods-diag'
let diag: Record<string, unknown> = {}
async function note($: EngineInterface, fields: Record<string, unknown>) {
  if (!cfg.diagnostics) return
  try {
    diag = { ...diag, build: BUILD, ...fields }
    await $.fs.write(`${DIAG_DIR}/context-pit-crew-${await $.session.id()}.json`, JSON.stringify(diag, null, 1))
  } catch {
    // Breadcrumbs are best effort; never let them break the mod.
  }
}

// Ends a running check or handoff, with a line on the band when there is something to say.
async function endPending($: EngineInterface, text?: string, toneName = 'warning') {
  checkTimer?.cancel()
  checkTimer = undefined
  checkTurnStarted = false
  await update($, checkPending, () => false)
  await update($, handoffPending, () => false)
  await update($, pendingSince, () => null)
  if (text) await say($, text, toneName)
}

// A check or handoff with no verdict after CHECK_TIMEOUT_MS is dropped. `at` names the check a timer was armed for;
// without it, any pending one past the timeout (or from before this build, with no start time) goes.
async function expireStale($: EngineInterface, at?: number) {
  if (!((await read($, checkPending)) || (await read($, handoffPending)))) return
  const since = await read($, pendingSince)
  if (at !== undefined ? since !== at : since !== null && (await $.clock.now()) - since < CHECK_TIMEOUT_MS) return
  // A check whose own turn is still running is not stale: its turn's end closes it. Look again later.
  if (working) {
    if (at !== undefined) checkTimer = $.clock.after(CHECK_TIMEOUT_MS, () => void expireStale($, at))
    return
  }
  await endPending($, "No verdict after 10 minutes, so the check was dropped. Claude's reply says what happened.")
}

// Submits a check's or handoff's prompt. One the engine drops (a Stop that stands, a reached limit) or refuses never
// starts a turn, so the pending state ends at once with the reason instead of spinning until its timeout.
async function submitPrompt($: EngineInterface, args: () => Promise<PromptSubmitArgs>, name: string) {
  try {
    const r = await $.prompt.submit(await args())
    if (typeof r.drop === 'string') await endPending($, `${name} did not start: ${r.drop.trim().replace(/\.$/, '').slice(0, 80) || 'the prompt was dropped'}.`, 'error')
  } catch (err) {
    await endPending($, `${name} did not start: ${String(err).slice(0, 80)}.`, 'error')
  }
}

// What a press, a command or Auto may not interrupt: Claude's turn, a running check or handoff, or the mod's own compaction.
async function busy($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const since = await read($, compactingSince)
  if (since !== null && now - since < COMPACT_TIMEOUT_MS) return 'A compaction is already under way.'
  await expireStale($)
  if ((await read($, checkPending)) || (await read($, handoffPending)))
    return 'A check is already running: wait for its result, or type a message to cancel it.'
  if (working) return "Claude is working: press again once the turn ends."
  if (await read($, compactPlan)) return `A confirmed compaction is waiting: press ${CHECK_NAME}, or type a message to drop it.`
  return ''
}

// auto: the Auto setting started it, so the prompt says so.
async function startCheck($: EngineInterface, why: string, source: Source = 'button') {
  const blocked = await busy($)
  if (blocked) {
    $.ui.toast(blocked, { timeoutMs: 8000 })
    return
  }
  const at = await $.clock.now()
  await note($, { checkStartAt: at })
  await update($, checkPending, () => true)
  await update($, pendingSince, () => at)
  await update($, compactPlan, () => null)
  await update($, handedOff, () => null)
  await update($, dismissedStatus, () => null)
  // Any check spends this compaction cycle's Auto run, so Auto never repeats a check you just ran or one Claude just refused.
  await update($, autoFired, () => true)
  checkTurnStarted = false
  checkTimer?.cancel()
  checkTimer = $.clock.after(CHECK_TIMEOUT_MS, () => void expireStale($, at))
  $.ui.toast(why)
  await submitPrompt($, async () => ({ text: checkPrompt(source, await autoLevel($)) }), 'The check')
}

// A button press or the command is the person's request for a new session, so it is sent as their words; the Auto setting's is not.
async function startHandoff($: EngineInterface, why: string, source: Source = 'button') {
  const blocked = await busy($)
  if (blocked) {
    $.ui.toast(blocked, { timeoutMs: 8000 })
    return
  }
  const at = await $.clock.now()
  await note($, { handoffStartAt: at })
  await update($, handoffPending, () => true)
  await update($, pendingSince, () => at)
  await update($, handedOff, () => null)
  await update($, handoffHint, () => null)
  await update($, dismissedStatus, () => null)
  await update($, autoFired, () => true)
  checkTurnStarted = false
  checkTimer?.cancel()
  checkTimer = $.clock.after(CHECK_TIMEOUT_MS, () => void expireStale($, at))
  $.ui.toast(why)
  await submitPrompt(
    $,
    async () => {
      const text = handoffPrompt(source, await autoLevel($))
      return source === 'auto' ? { text } : { text, asUser: true }
    },
    'The handoff',
  )
}

// The one way the mod compacts. It claims the compaction and takes the plan before its first wait, so a second press,
// another measurement or a retry finds it claimed and starts nothing.
async function compactWhenIdle($: EngineInterface, plan: string, pressed = false) {
  // Never queued mid-turn: a /compact queued then cannot be taken back if you type. The turn's end schedules it again.
  if (working) {
    if (pressed) $.ui.toast('Claude is working: the confirmed compaction runs when the turn ends.', { timeoutMs: 8000 })
    return
  }
  const now = await $.clock.now()
  // The claim and the plan are each taken in one compare-and-set, so two callers can never both win.
  let won = false
  await update($, compactingSince, c => {
    won = c === null || now - c >= COMPACT_TIMEOUT_MS
    return won ? now : c
  })
  if (!won) return
  let mine = false
  await update($, compactPlan, p => {
    mine = p === plan
    return mine ? null : p
  })
  if (!mine) {
    await update($, compactingSince, c => (c === now ? null : c))
    return
  }
  gaveUp = undefined
  // A check that confirmed this plan is over, whatever its turn does next.
  await endPending($)
  await tryCompact($, plan, now, compactSeq, 0)
}

// $.session.compact refuses while a turn runs, and a turn's end comes before the session is idle: retry until it takes.
// A typed message or a /clear drops the claim, and a compaction that happened meanwhile ends the retries.
async function tryCompact($: EngineInterface, plan: string, claim: number, seq: number, attempt: number) {
  if ((await read($, compactingSince)) !== claim) return
  // A compaction happened meanwhile (the queued /compact, or the host's): this one is done, and its claim goes.
  if (compactSeq !== seq) {
    await update($, compactingSince, c => (c === claim ? null : c))
    return
  }
  // Recorded before the call, so an attempt that hangs or is cut off still leaves a trace.
  await note($, { compactTryAt: await $.clock.now(), compactTry: attempt + 1 })
  let retrying = false
  try {
    if (attempt === 0) {
      // First choice: queue /compact exactly as if typed. The engine runs it once the session is idle and settles after it ran.
      const r = await $.command.run({ command: 'compact', args: plan })
      if (compactSeq === seq) throw new Error((r.text ?? '').trim() || 'the /compact did not run')
      await note($, { compactQueuedAt: await $.clock.now() })
      return
    }
    const r = await $.session.compact({ instructions: plan })
    await note($, { compactAt: await $.clock.now(), compactAttempts: attempt + 1, compactSkip: 'skip' in r ? r.skip ?? null : null })
    if ('skip' in r && r.skip) $.ui.toast(`Compaction skipped: ${r.skip}`, { timeoutMs: 10000 })
    // The mod's own $.session.compact runs every hook but its own, so it records the compaction itself.
    else await compactionDone($, r, true)
  } catch {
    await note($, { compactError: true, compactAttempts: attempt + 1 })
    if (attempt < 40 && (await read($, compactingSince)) === claim && compactSeq === seq) {
      retrying = true
      $.clock.after(1500, () => void tryCompact($, plan, claim, seq, attempt + 1))
      return
    }
    if (compactSeq === seq && (await read($, compactingSince)) === claim) {
      // Out of retries: the plan waits again, so a press, or the next turn's end, tries once more.
      await update($, compactPlan, p => p ?? plan)
      gaveUp = plan
      $.ui.toast(`The compaction did not start. Press ${CHECK_NAME} to try again, or type /compact.`, { timeoutMs: 15000 })
    }
  } finally {
    if (!retrying) await update($, compactingSince, c => (c === claim ? null : c))
  }
}

// Refresh: re-read the figures, then reload every plugin from disk, as typing /reload-plugins does once the session is idle.
async function refreshMods($: EngineInterface) {
  await record($, toSnapshot(await $.session.usage(), await $.clock.now()))
  // A reload cancels this mod's timers and retries, so it waits while a check, a handoff or a compaction is under way.
  const blocked = await busy($)
  if (blocked) {
    // Lower-cased to read mid-sentence, except the name "Claude".
    const why = blocked.replace(/:.*$|\.$/, '').replace(/^(?!Claude\b)[A-Z]/, c => c.toLowerCase())
    $.ui.toast(`Figures refreshed. The mods were not reloaded: ${why}.`, { timeoutMs: 8000 })
    await say($, `Figures refreshed. Reload skipped: ${why}.`, 'warning')
    return
  }
  $.ui.toast('Reloading the mods…')
  await note($, { refreshAt: await $.clock.now() })
  await say($, 'Figures refreshed; reloading the mods…', 'suggestion')
  let r: { text?: string } = {}
  try {
    r = await $.command.run({ command: 'reload-plugins' })
  } catch (err) {
    r = { text: `refused: ${String(err)}` }
  }
  // Show what the reload itself said. A session can refuse it as "a remote connection" with the Remote Control toggle off
  // (seen live 2026-10-27), so no reply is blamed on Remote Control: a new session loads the update either way.
  const said = (r.text ?? '').trim()
  await note($, { refreshResult: said.slice(0, 200) || null })
  const first = (said.split('\n')[0] ?? '').slice(0, 120).replace(/\.$/, '')
  if (/isn't available|not available|refused|can't|cannot/i.test(said)) {
    $.ui.toast(`This session did not reload the mods (it says: ${first}). The figures were refreshed; a new session loads the updated mods.`, { timeoutMs: 15000 })
    await say($, 'Figures refreshed. This session cannot reload the mods; a new session will.', 'warning')
  } else {
    await say($, said ? `Figures refreshed. Reload: ${first}.` : 'Figures refreshed; mods reloaded.', 'success')
  }
}

async function openPane($: EngineInterface, section: 'context' | 'limits') {
  await update($, paneFocus, () => section)
  // A surface that cannot place the pane refuses; the press just does nothing.
  await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true }).catch(() => undefined)
}

// An absolute reset time, as the app's own usage panel shows it ("Thu 10:30 AM").
function resetAt(resetsAt: string | undefined): string {
  if (!resetsAt) return ''
  try {
    return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

async function say($: EngineInterface, text: string, toneName: string) {
  const at = await $.clock.now()
  await update($, lastNote, () => ({ text, tone: toneName, at }))
  // A new note is news, even in the words of one you dismissed.
  await update($, dismissedStatus, () => null)
}

// What every finished main-thread compaction changes. The session.compact hook calls it, and so does the mod's own
// $.session.compact, which runs every hook but its own.
async function compactionDone($: EngineInterface, r: { tokensAfter?: number; messages?: readonly { text: string }[] }, own: boolean) {
  compactSeq++
  gaveUp = undefined
  await update($, compactions, n => n + 1)
  // The after-compaction note goes only with a compaction the check confirmed; after the host's own it would speak over your request.
  if (own) await update($, justCompacted, () => true)
  await update($, nudged, () => [])
  await update($, autoFired, () => false)
  // You chose to compact over the suggested handoff, and an old dismissal or proposal no longer applies.
  await update($, handoffHint, () => null)
  await update($, handedOff, () => null)
  await update($, dismissedStatus, () => null)
  await afterCompaction($, r.tokensAfter, r.messages)
}

// The engine only re-measures after the next turn, so the band would keep the old size: work it out now from the
// local breakdown (system prompt, tools, memory and skills as well as the kept messages), or failing that the
// compaction's own count, which covers the messages alone, and mark it estimated until measured.
async function afterCompaction($: EngineInterface, tokensAfter?: number, messages?: readonly { text: string }[]) {
  const now = await $.clock.now()
  const prev = await read($, snapshot)
  const s = toSnapshot(await $.session.usage(), now)
  const window = s.context?.window ?? prev?.context?.window
  const b = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context.breakdown
  const summed = b ? b.categories.reduce((n, c) => n + (c.kind === 'used' ? c.tokens : 0), 0) : 0
  // Right after a compaction the breakdown can still count the old messages (a live run summed 625k with 47k kept).
  // The rest of it (system prompt, tools, memory, skills) is unchanged by a compaction, so the figure is that plus the
  // compaction's own message count; without a count, a sum near the pre-compaction size is taken as stale.
  const msgs = b?.categories.find(c => c.kind === 'used' && /message/i.test(c.name))?.tokens
  const before = prev?.context?.tokens ?? 0
  const used =
    tokensAfter !== undefined && msgs !== undefined ? summed - msgs + tokensAfter : before && summed >= before * 0.8 ? 0 : summed
  const kept = (used || undefined) ?? tokensAfter ?? (messages ? Math.round(messages.reduce((n, m) => n + m.text.length, 0) / 4) : undefined)
  if (window && kept !== undefined && (!s.context || s.context.tokens >= (prev?.context?.tokens ?? 0))) {
    s.context = { percent: (kept / window) * 100, tokens: kept, window, estimated: true }
  }
  await record($, s)
  await update($, lastReplyAt, () => now)
  await note($, { compactedAt: now, tokensAfter: tokensAfter ?? null, usedAfter: used || null, usedSummed: summed || null, ctxAfter: s.context?.percent ?? null })
  // From the second compaction on, the result line carries the handoff suggestion too, in the amber of its dot.
  const twice = (await read($, compactions)) >= 2 ? ' Compacted twice now: a new session would serve better.' : ''
  await say($, (s.context ? `Compacted. Context now ~${Math.round(s.context.percent)}%.` : 'Compacted.') + twice, twice ? 'warning' : 'success')
}

// What the band says once the handoff is proposed: a card to click, or outside the desktop app a printed brief.
function readyText(handed: string): string {
  return /brief printed/i.test(handed)
    ? 'New session ready: start a new session and paste the printed brief.'
    : `New session ready: click the "${handed}" card to start it.`
}

// What any measurement may do, mid-turn included: a confirmed plan compacts (the compaction itself waits until the
// session is idle), a proposed new session is announced once, and a check past its timeout is dropped.
async function afterMeasure($: EngineInterface) {
  const now = await $.clock.now()
  await update($, lastReplyAt, () => now)
  await note($, { afterTurnAt: now, planWaiting: Boolean(await read($, compactPlan)) })
  const plan = await read($, compactPlan)
  if (plan && planScheduled !== plan) {
    planScheduled = plan
    await endPending($)
    $.ui.toast('Safe spot confirmed. Compacting as soon as the session is idle…', { timeoutMs: 8000 })
    $.clock.after(1000, () => {
      planScheduled = undefined
      void compactWhenIdle($, plan)
    })
  }
  const handed = await read($, handedOff)
  if (handed && !handed.announced) {
    await endPending($)
    await update($, handedOff, h => (h ? { ...h, announced: true } : h))
    $.ui.toast(readyText(handed.name), { timeoutMs: 10000 })
  }
  await expireStale($)
  coldWarning?.cancel()
  coldWarning = $.clock.after(cfg.cacheTtlMs - cfg.coldWarningMs, () => {
    void read($, snapshot).then(s => {
      const size = s?.context ? ` (~${kTokens(s.context.tokens)} tokens to re-write)` : ''
      $.ui.toast(`By your ${Math.round(cfg.cacheTtlMs / 60000)}-minute cache setting, the prompt cache likely goes cold in ${Math.round(cfg.coldWarningMs / 60000)} min${size}. Reply, /compact or hand off now.`, { timeoutMs: 15000 })
    })
  })
  ticker ??= $.clock.every(60 * 1000, () => void update($, tick, n => n + 1))
}

// The real end of a turn: turn.complete where it arrives (the terminal), or the band seeing isWorking fall (the desktop).
// Only here may a check end without a verdict, or Auto start, since a measurement can also come mid-turn.
async function turnEnded($: EngineInterface, reason?: string) {
  if (reason !== undefined) lastTurnReason = reason
  // A stopped, refused or failed turn (known on the terminal only) drops a plan it confirmed: nothing compacts after it.
  if (reason !== undefined && reason !== 'answer' && (await read($, compactPlan))) {
    await update($, compactPlan, () => null)
    await endPending($, `The turn ${reason === 'aborted' ? 'was stopped' : reason === 'refusal' ? 'was refused by the model' : 'ended with an error'}, so the confirmed compaction was dropped.`)
  }
  // Before afterMeasure, whose timeout sweep would otherwise speak first for a long check that just ended.
  const handed = await read($, handedOff)
  if (checkTurnStarted && !(await read($, compactPlan)) && !(handed && !handed.announced)) {
    const handing = await read($, handoffPending)
    if (handing || (await read($, checkPending))) {
      // Claude ended the check's own turn without calling either tool (it asked you something, say): the check is over.
      await endPending($, `${handing ? 'Handoff' : 'Check'} ended without a verdict: Claude's reply says why.`)
    }
  }
  await afterMeasure($)
  await maybeAuto($)
}

// Auto: once between compactions, never over a running turn, check, handoff or compaction, and never after a turn the
// terminal reports stopped. The desktop sends no end reason, so there a stopped turn cannot be told from an answered one.
async function maybeAuto($: EngineInterface) {
  const stopped = () => working || (lastTurnReason !== undefined && lastTurnReason !== 'answer')
  if (stopped() || !(await read($, autoCheck)) || (await read($, autoFired))) return
  const level = await autoLevel($)
  if (((await read($, snapshot))?.context?.percent ?? 0) < level) return
  if ((await read($, compactPlan)) || (await busy($))) return
  await update($, autoFired, () => true)
  await update($, autoWaiting, () => true)
  // Twice compacted already: a summary of a summary loses more, so the automatic step is a handoff instead.
  const twice = (await read($, compactions)) >= 2
  // A short wait lets a late turn.complete (a stopped turn) or a typed message arrive first; either wins over Auto for
  // this turn's end only: the wait gives the run back (here, or in dropAutoWait), so the next turn's end may start it.
  autoTimer?.cancel()
  autoTimer = $.clock.after(1500, () => {
    autoTimer = undefined
    void update($, autoWaiting, () => false)
    if (stopped()) {
      void update($, autoFired, () => false)
      return
    }
    void (twice
      ? startHandoff($, `Context past ${level}% after two compactions: running the automatic handoff check…`, 'auto')
      : startCheck($, `Context past ${level}%: running the automatic pre-compaction check…`, 'auto'))
  })
}

// Ends Auto's wait before it started a check (a typed message, a /clear, a reload that killed the timer) and gives back
// the run the wait had taken. A check already started keeps its run spent, so Auto never repeats it.
async function dropAutoWait($: EngineInterface) {
  autoTimer?.cancel()
  autoTimer = undefined
  if (!(await read($, autoWaiting))) return
  await update($, autoWaiting, () => false)
  await update($, autoFired, () => false)
}

// A /clear keeps the process but starts a new conversation with no session.start: everything about the old one goes.
async function resetConversation($: EngineInterface) {
  checkTimer?.cancel()
  checkTimer = undefined
  coldWarning?.cancel()
  coldWarning = undefined
  await dropAutoWait($)
  checkTurnStarted = false
  lastTurnReason = undefined
  planScheduled = undefined
  gaveUp = undefined
  // The old conversation's context figure goes too (the limits stay), so no nudge or Auto acts on it before the next measurement.
  await update($, snapshot, sn => (sn ? { ...sn, context: undefined } : sn))
  await update($, compactions, () => 0)
  await update($, justCompacted, () => false)
  await update($, checkPending, () => false)
  await update($, handoffPending, () => false)
  await update($, pendingSince, () => null)
  await update($, compactPlan, () => null)
  await update($, compactingSince, () => null)
  await update($, autoFired, () => false)
  await update($, handedOff, () => null)
  await update($, handoffHint, () => null)
  await update($, hintReasons, () => [])
  await update($, lastNote, () => null)
  await update($, dismissedStatus, () => null)
  await update($, nudged, () => [])
  await update($, lastReplyAt, () => null)
  // The limits belong to the account, not the conversation, so only the context warnings start over.
  await update($, warned, list => list.filter(key => !key.startsWith('Context:')))
}

export const register: Register = (on, options) => {
  cfg = configFrom(options)
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await note($, { turnCompleteAt: await $.clock.now(), turnAgentId: e.agentId ?? null, turnReason: e.reason })
    if (e.agentId === undefined) {
      // A check never starts while Claude works, so a turn that ends while one is pending is the check's own.
      if ((await read($, checkPending)) || (await read($, handoffPending))) checkTurnStarted = true
      await turnEnded($, e.reason)
    }
    return ran
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetConversation($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pit-crew',
      description: `Usage pane; "check" compacts at a safe spot, "handoff" moves to a fresh session, "auto on|off|N" runs the check past N% (default ${cfg.ctxCompact}), "help" lists the buttons`,
      argumentHint: '[check|handoff|refresh|auto on|auto off|help]',
    })
    await $.tool.register({
      name: READY_TOOL,
      description:
        'Call only at the end of a pre-compaction check started by the Context Pit Crew Check & compact button, its /pit-crew check command or its Auto setting, ' +
        'after confirming every good-spot condition holds (nothing half-done, a parked step counting as done; no question waiting on the user; background work running on its own) ' +
        'and the state page, if the session keeps one, is current. ' +
        'The session compacts as soon as this turn ends, keeping what you pass here. Never call it otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          state_page: { type: 'string', description: 'Absolute path of the start-here state page, or "none" if the session keeps none' },
          pending_decisions: { type: 'string', description: 'Questions waiting on the user, word for word, or "none"' },
          background_tasks: { type: 'string', description: 'Each running background task: ID, what it is, what to do when it lands; or "none"' },
          next_step: { type: 'string', description: 'The exact next step after compacting' },
        },
        required: ['state_page', 'next_step'],
      },
    })
    await $.tool.register({
      name: NOT_SAFE_TOOL,
      description:
        'Call only at the end of a pre-compaction check or handoff started by the Context Pit Crew buttons, its /pit-crew command or its Auto setting, when a good-spot ' +
        'condition fails, so the band shows the reason at once. Nothing compacts or hands off. Never call it otherwise.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'What blocks it, in one short line (e.g. "an approval is waiting on you")' } },
        required: ['reason'],
      },
    })
    await $.tool.register({
      name: HANDOFF_TOOL,
      description:
        'Call only at the end of a handoff started by the Context Pit Crew New session button, its /pit-crew handoff command or its Auto setting, after the good-spot check passed, ' +
        'the state page was refreshed and the fresh session was proposed as a card (or the brief printed). Never call it otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          state_page: { type: 'string', description: 'Absolute path of the refreshed state page, or "none" if the session keeps none' },
          new_session: { type: 'string', description: 'The proposed card\'s title, or "brief printed" outside the desktop app' },
        },
        required: ['state_page', 'new_session'],
      },
    })
    await $.tool.register({
      name: SUGGEST_TOOL,
      description:
        'Suggest, without starting anything, that the user move this work to a fresh session: call it when a new session would serve ' +
        'better than carrying on or compacting: when the work has moved to a topic unrelated to what this session began with. ' +
        '(The band already suggests it by itself after two compactions.) The Context Pit Crew band shows ' +
        'the suggestion and the user decides with its New session button. Call it once per reason, never during a check or handoff, ' +
        'and mention the suggestion in one line of your reply.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why a fresh session would serve better, in a few words (e.g. "the topic moved to the travel app")' } },
        required: ['reason'],
      },
    })
    await note($, { loadedAt: await $.clock.now() })
    const savedAuto = await $.store.get('autoCheck')
    if (typeof savedAuto === 'boolean') await update($, autoCheck, () => savedAuto)
    const savedAt = await $.store.get('autoAt')
    if (typeof savedAt === 'number' && autoLevelOk(savedAt)) await update($, autoAt, () => savedAt)
    // A check or compaction left from before a reload or a crash never blocks this session, and nor does an Auto wait
    // whose timer the reload killed: the run it had taken goes back.
    await expireStale($)
    await dropAutoWait($)
    // No compaction chain outlives a reload or a restart, so a claim left in the atoms is dropped.
    await update($, compactingSince, () => null)
    if (cfg.openPaneOnStart) $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
    const ran = await next(e)
    await record($, toSnapshot(await $.session.usage(), await $.clock.now()))
    return ran
  })

  on('command.run', { command: 'pit-crew' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'check' || arg === 'handoff') {
      const plan = await read($, compactPlan)
      if (arg === 'check' && plan) {
        $.clock.after(300, () => void compactWhenIdle($, plan, true))
        return { text: 'Compacting the confirmed plan.' }
      }
      const blocked = await busy($)
      if (blocked) return { text: blocked }
    }
    if (arg === 'check') {
      // A prompt can't be submitted from inside a command's own dispatch; start it once the command has settled.
      $.clock.after(300, () => void startCheck($, 'Running the pre-compaction check…', 'command'))
      return { text: 'Pre-compaction check starting.' }
    }
    if (arg === 'refresh') {
      $.clock.after(300, () => void refreshMods($))
      return { text: 'Refreshing the figures, then reloading the mods.' }
    }
    if (arg === 'handoff') {
      $.clock.after(300, () => void startHandoff($, 'Running the handoff check…', 'command'))
      return { text: 'Handoff check starting.' }
    }
    // Anything after "auto" is an answer to it: on, off, or a whole level (70 or 70%); the rest is refused, not shown as the pane.
    const autoArg = /^auto\s+(.+)$/.exec(arg)
    if (autoArg) {
      const word = autoArg[1]
      const turnOn = word !== 'off'
      if (word !== 'on' && word !== 'off') {
        const level = /^(\d+)%?$/.exec(word)
        const at = level ? Number(level[1]) : 0
        if (at < 1 || at > 99) return { text: 'Give a level from 1 to 99, for example /pit-crew auto 70.' }
        await setAutoLevel($, at)
      }
      await setAuto($, turnOn)
      return { text: `Automatic pre-compaction check ${turnOn ? `on: it runs once when a turn ends past ${await autoLevel($)}% context` : 'off'}.` }
    }
    if (arg === 'help') return { text: helpText(await autoLevel($)) }
    await record($, toSnapshot(await $.session.usage(), await $.clock.now()))
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const s = await read($, snapshot)
    return { text: opened.isPlaced ? 'Usage pane opened. "/pit-crew help" lists what the buttons do.' : (s && statusText(s, await $.clock.now())) ?? 'No usage reading yet.' }
  })

  on('session.measure', async ($, e, next) => {
    const s = toSnapshot(e, await $.clock.now())
    // A measurement that moved only the limits or the cost keeps the post-compaction estimate until the context is measured.
    const prev = (await read($, snapshot))?.context
    if (!e.changed.includes('context') && prev?.estimated) s.context = prev
    await record($, s)
    // Which limit windows each reading reports, so a live run shows whether five_hour ever comes (carry-over keeps
    // only a window the session has already read).
    await note($, { measureAt: await $.clock.now(), measureChanged: e.changed.join(','), limitKinds: e.rateLimits.map(r => r.kind).join(',') })
    // The engine measures after each main-thread turn, and the desktop raises no turn.complete for mods. A measurement can
    // also come mid-turn, so it only does what is safe then; a check's end and Auto wait for the turn's real end.
    if (e.changed.includes('context')) await afterMeasure($)
    return next(e)
  })

  // The context budget: one-time notes to Claude as the context crosses each threshold, and after a compaction.
  on('prompt.submit', async ($, e, next) => {
    // Which origin the desktop and the terminal stamp on a typed prompt, and whether a typed command raises this hook, is read from here.
    await note($, { promptAt: await $.clock.now(), promptOrigin: e.origin.kind, promptCommand: e.command?.name ?? null })
    // A typed /pit-crew command is not a new message: the engine may raise this hook for it (after command.run, with the
    // composer's origin), and treating it as one would drop the plan or the check the command just acted on.
    if (e.command?.name === 'pit-crew') return next(e)
    // A new turn: the last one's end reason no longer applies.
    lastTurnReason = undefined
    // The mod's own prompts skip this hook anyway (a plugin's submit passes every hook but its own); this guards a second copy.
    if (e.origin.kind === 'plugin' && e.origin.name === 'context-pit-crew') return next(e)
    // Typing something else abandons a running check and the mod's compaction retries, so a late tool call can no longer
    // compact over your question; it also clears the "New session ready" line, which you have answered by typing.
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      // Auto's wait loses to your message, but only for this turn's end: the next one may start it.
      await dropAutoWait($)
      await endPending($)
      await update($, compactPlan, () => null)
      await update($, compactingSince, () => null)
      await update($, handedOff, () => null)
    }

    // The notes speak to your next message. A background task's notification, another session's message, a schedule or a
    // prompt another plugin sent as its own carries none, and leaves them for the message that is yours.
    if (e.origin.kind === 'plugin' ? e.origin.asUser !== true : e.isMeta === true || NOT_YOUR_WORDS.has(e.origin.kind)) return next(e)
    const notes: string[] = []
    if (await read($, justCompacted)) {
      notes.push(AFTER_COMPACT)
      await update($, justCompacted, () => false)
    }
    const pct = (await read($, snapshot))?.context?.percent
    if (pct !== undefined) {
      const done = await read($, nudged)
      const due = [cfg.ctxOverdue, cfg.ctxCompact, cfg.ctxStatePage].find(level => pct >= level && !done.includes(level))
      if (due !== undefined) {
        notes.push(nudge(due, Math.round(pct)))
        // Crossing a higher line covers the lower ones too.
        await update($, nudged, list => [...new Set([...list, ...[cfg.ctxStatePage, cfg.ctxCompact, cfg.ctxOverdue].filter(l => l <= due)])])
      }
    }
    if (!notes.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  }).catch(($, e, next) => next(e)) // Fail open: a fault here must never block a prompt.

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    // The mod's own plan carries its keep and drop lines; any other compaction (the host's, a typed /compact) gets them added.
    const own = e.instructions?.includes(PLAN_MARK) ?? false
    // A /compact the mod queued whose claim a typed message dropped: the engine cannot take it back, so it is vetoed here.
    if (own && (await read($, compactingSince)) === null) return { skip: 'A typed message dropped the Context Pit Crew compaction plan.' }
    const instructions = own ? e.instructions : e.instructions ? `${e.instructions}\n\n${KEEP_LINE}` : KEEP_LINE
    const r = await next({ ...e, instructions })
    if (!('skip' in r && r.skip)) await compactionDone($, r, own)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__context-pit-crew__ready_to_compact' }, async ($, e) => {
    if (!(await read($, checkPending))) {
      return { result: `Refused: no pre-compaction check is running. The user starts one with the ${CHECK_NAME} button.` }
    }
    const args = e as unknown as Record<string, unknown>
    const field = (k: string, fallback: string) => (typeof args[k] === 'string' && args[k] ? String(args[k]) : fallback)
    // Only a path counts as a page; "none" or any other wording means the session keeps none.
    const page = field('state_page', 'none').trim()
    const plan =
      (/^(\/|~\/|[A-Za-z]:\\)/.test(page) ? `State page: ${page} (read it before continuing the earlier work). ` : 'This session keeps no state page. ') +
      `Pending decisions: ${field('pending_decisions', 'none')}. ` +
      `Running background tasks: ${field('background_tasks', 'none')}. ` +
      `Next step: ${field('next_step', 'as the state page says')}. ` +
      `Drop: file contents and tool output already captured on the state page or in this plan. ${PLAN_MARK}`
    await update($, compactPlan, () => plan)
    return { result: 'Recorded. The session compacts as soon as this turn ends. Finish your reply in one line.' }
  })

  on('tool.call', { tool: 'mcp__context-pit-crew__not_safe_to_compact' }, async ($, e) => {
    const handoff = await read($, handoffPending)
    if (!handoff && !(await read($, checkPending))) {
      return { result: 'Refused: no check or handoff is running.' }
    }
    const args = e as unknown as Record<string, unknown>
    const reason = (typeof args.reason === 'string' ? args.reason.trim().replace(/\.$/, '').trim() : '') || 'see the reply'
    await update($, compactPlan, () => null)
    await endPending($, `Not safe to ${handoff ? 'hand off' : 'compact'}: ${reason}.`, 'error')
    await note($, { notSafeAt: await $.clock.now(), notSafe: true })
    return { result: 'Recorded. The band shows the reason. Say what blocks it and what would make it safe.' }
  })

  on('tool.call', { tool: 'mcp__context-pit-crew__ready_to_hand_off' }, async ($, e) => {
    if (!(await read($, handoffPending))) {
      return { result: 'Refused: no handoff is running. The user starts one with the New session button.' }
    }
    const args = e as unknown as Record<string, unknown>
    const name = typeof args.new_session === 'string' && args.new_session ? args.new_session : 'the new session'
    const at = await $.clock.now()
    await update($, handedOff, () => ({ name, at, announced: false }))
    return {
      result: /brief printed/i.test(name)
        ? 'Recorded. End with one line: paste the printed brief into a new session in this folder.'
        : 'Recorded. End with one line: click the card to start the new session.',
    }
  })

  on('tool.call', { tool: 'mcp__context-pit-crew__suggest_new_session' }, async ($, e) => {
    if ((await read($, checkPending)) || (await read($, handoffPending))) {
      return { result: 'Not recorded: a check or handoff is already running.' }
    }
    const args = e as unknown as Record<string, unknown>
    const reason = (typeof args.reason === 'string' ? args.reason.trim().replace(/\.$/, '').trim().slice(0, 120) : '') || 'Claude suggests it'
    // Once per reason: a repeat, even of one you dismissed, is not raised again.
    if ((await read($, hintReasons)).includes(reason.toLowerCase())) {
      return { result: 'Not recorded: that reason was already suggested this session. Carry on with the work.' }
    }
    await update($, hintReasons, list => [...list, reason.toLowerCase()])
    const at = await $.clock.now()
    await update($, handoffHint, () => ({ reason, at }))
    await note($, { hintAt: at, hint: true })
    $.ui.toast(`Claude suggests a new session: ${reason}.`, { timeoutMs: 10000 })
    return { result: 'Recorded. The band suggests a new session; say so in one line at the end of your reply and carry on with the work.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    // The terminal resolves Svg but draws it as an empty box, so it gets the block-character bars.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const s = await read($, snapshot)
    await read($, tick)
    const now = await $.clock.now()
    const left = cacheLeft(await read($, lastReplyAt), now)
    const compacted = await read($, compactions)
    const focus = await read($, paneFocus)

    // One text size throughout, as the app's own footer: each section's title semibold, its value normal (toned only
    // once it warns), its details and names dim. Bars are the app's blue, amber past the warning line, red past the limit.
    const title = (text: string) => <Text weight="semibold">{text}</Text>
    const row = (label: string, pct: number | undefined, detail: string, colour: (p: number) => Tone = tone, empty = 'No reading yet', approx = false) => {
      if (pct === undefined) {
        return (
          <Box flexDirection="column" marginBottom={1}>
            {title(label)}
            <Text dimColor>{empty}</Text>
          </Box>
        )
      }
      const t = colour(pct)
      const blocks = bar(pct, BAR_WIDTH)
      return (
        <Box flexDirection="column" marginBottom={1}>
          {title(label)}
          <Box flexDirection="row" alignItems="center" columnGap="sm">
            {Svg ? (
              <Svg source={svgBar(pct, t, 160, 8)} alt={`${label} ${Math.round(pct)}%`} width={160} height={8} />
            ) : (
              <Text>
                <Text color={t}>{blocks.fill}</Text>
                <Text color="subtle">{blocks.track}</Text>
              </Text>
            )}
            <Text color={valueTone(t)}>{`${approx ? '~' : ''}${pct.toFixed(pct % 1 ? 1 : 0)}%`}</Text>
          </Box>
          {detail !== '' && <Text dimColor>{detail}</Text>}
        </Box>
      )
    }

    if (!s) return <Text dimColor>Waiting for the first response…</Text>

    const ctxDetail = s.context
      ? [
          // Estimated after a compaction until the next measurement; the breakdown below may still show the old messages.
          `${s.context.estimated ? '~' : ''}${kTokens(s.context.tokens)} of ${kTokens(s.context.window)} tokens`,
          ctxAdvice(s.context.percent, compacted),
          compacted ? `${compacted} compaction${compacted === 1 ? '' : 's'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

    // The context by category, as /context counts it; "summary" is worked out locally and sends no request.
    const usage = await $.session.usage({ breakdown: 'summary', columns: e.props.bodyColumns }).catch(() => undefined)
    const b = usage?.context.breakdown
    // A category's name and share are dim and its token count is the value; a category that is not used (free space,
    // a buffer) is dim throughout. The swatch is the engine's own colour for the category, as /context draws it.
    const line = (key: string, swatch: string, name: string, tokens: string, share: string, unused = false) => (
      <Box key={key} flexDirection="row">
        <Text color={swatch}>■ </Text>
        <Box flexGrow={1}>
          <Text dimColor wrap="truncate-end">{name}</Text>
        </Box>
        <Box width={8} justifyContent="flex-end">
          <Text dimColor={unused}>{tokens}</Text>
        </Box>
        <Box width={7} justifyContent="flex-end">
          <Text dimColor>{share}</Text>
        </Box>
      </Box>
    )
    const contextSection = (
      <Box key="context" flexDirection="column">
        {row('Context window', s.context?.percent, ctxDetail, ctxTone, 'No reading yet', s.context?.estimated)}
        {b && (
          <Box flexDirection="column" marginBottom={1}>
            {b.categories
              .filter(c => !c.isDeferred)
              .map(c =>
                line(c.name, c.color, c.name, kTokens(c.tokens), `${((c.tokens / b.maxTokens) * 100).toFixed(1)}%`, c.kind !== 'used'),
              )}
            {b.categories
              .filter(c => c.isDeferred)
              .map(c => line(c.name, c.color, `${c.name} (deferred)`, kTokens(c.tokens), '—', true))}
            {b.autoCompactThreshold !== undefined && (
              <Text dimColor>Auto-compact at {kTokens(b.autoCompactThreshold)} tokens</Text>
            )}
          </Box>
        )}
      </Box>
    )
    // Before the first reply a limit may just not have been reported yet; after it, a missing window is one the plan does not have.
    const lastReply = await read($, lastReplyAt)
    const limit = (label: string, m: Meter | undefined) =>
      row(label, m?.percent, [untilReset(m?.resetsAt, now), resetAt(m?.resetsAt)].filter(Boolean).join(' · '), tone, lastReply === null ? 'No reading yet' : 'Not on this plan')
    const limitsSection = (
      <Box key="limits" flexDirection="column">
        {limit('5-hour session limit', drawn(s.fiveHour, now))}
        {limit('Weekly limit', drawn(s.weekly, now))}
        {left !== undefined && (
          <Box flexDirection="column" marginBottom={1}>
            {title('Prompt cache')}
            <Text color={valueTone(cacheTone(left))}>{left > 0 ? `about ${Math.ceil(left / 60000)}m left` : 'likely cold'}</Text>
            <Text dimColor>
              {left > 0
                ? `likely warm, an estimate from your ${Math.round(cfg.cacheTtlMs / 60000)}-minute setting`
                : 'the next reply may re-write the whole context'}
            </Text>
          </Box>
        )}
        {s.usd !== undefined && (
          <Box flexDirection="column" marginBottom={1}>
            {title('Session cost (API-equivalent)')}
            <Text>${s.usd.toFixed(2)}</Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {focus === 'limits' ? [limitsSection, contextSection] : [contextSection, limitsSection]}
      </Box>
    )
  })

  // The meter and the budget controls, in the band directly above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band is drawn again when a turn starts and ends: its fall is the desktop's end-of-turn signal.
    const was = working
    working = e.props.isWorking
    // A turn that starts while a check is pending is the check's own (a press is refused while Claude works).
    if (!was && working && ((await read($, checkPending)) || (await read($, handoffPending)))) checkTurnStarted = true
    if (was && !working) $.clock.after(0, () => void turnEnded($))
    const s = await read($, snapshot)
    if (e.props.hasSurvey || !s) return next(e)
    if (!bandDrawn) {
      bandDrawn = true
      $.ui.status(undefined)
    }
    await read($, tick)
    const now = await $.clock.now()
    const left = cacheLeft(await read($, lastReplyAt), now)
    const compacted = await read($, compactions)
    // A check past its timeout is no longer drawn as running; the measurement or timer that ends it may come later.
    const since = await read($, pendingSince)
    const live = since !== null && (working || now - since < CHECK_TIMEOUT_MS)
    const pending = live && (await read($, checkPending))
    const auto = await read($, autoCheck)
    const level = await autoLevel($)
    const pct = s.context?.percent ?? 0
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The terminal resolves Svg but draws it as an empty box, so it gets the block-character bars and the ✻ mark.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    // Auto's menu. The mobile app draws no Select (its table resolves one, but as an empty box, as the terminal's does Svg),
    // so there Auto is a plain button that steps through the same options.
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : undefined

    // Claude Code's own design language, as its footer draws "Bypass permissions" and "Opus 5.5 High": quiet text
    // controls with the app's hover pill, a name dim beside a value in normal text, colour only where it means
    // something, and spacing (not dividers) to group. Every Text in the band is caption size, as it was before 28o (that
    // size was restored on request, 2026-10-28): a desktop draws a Button's label at its own size whatever the band
    // asks, so the names and buttons keep that size and the figures, dots and status line sit a step smaller.
    // Inside a meter the parts sit one caption space apart, not a gap step: seen live (28o), a gap step plus a Button's
    // own padding (about 10 points a side on the desktop) spread each meter wide enough to push Cost onto a second line.
    // The desktop's plain Button padding was measured live (28o), so there the part after a name needs no space of its
    // own. Every other surface gets the caption space: the terminal's plain Button is the label alone, and the padding
    // of VS Code's and the mobile app's has not been measured, so a name must not run into its bar or figure there.
    // The meters sit the smallest step (xs, about 8 points on the desktop) apart, which with the next name's own padding
    // still parts them about twice as far as a name from its bar. The terminal draws xs and sm alike, as one cell.
    // Not yet seen live on the desktop: how it draws a Select (its own padding and look), and so whether the five
    // meters fit a measured band on one line (worked out from 28o's screenshots at about 680 to 700 points of about
    // 710, depending on the figures; the sm step would leave about half that margin).
    const padded = e.surface === 'desktop'
    //
    // A meter's name is a dim plain Button that opens the Usage pane at its own section.
    const opener = (label: string, section: 'context' | 'limits') => (
      <Button key={`open-${label}`} label={label} plain dimColor onPress={() => void openPane($, section)} />
    )
    // A control, the state dot before it, and its tip card, revealed just above it while the pointer is on the control's
    // keyed Box. A tip drawn beside the control pushed the next buttons along and could wrap the row, so the band grew,
    // the chat moved, the pointer slid off and the whole view flickered. The card is out of the flow, so showing it moves
    // nothing; its own width keeps it from being squeezed to the button's width.
    // The dot is a coloured Text beside the Button, not inside it: seen live, a desktop draws a Button's label as plain
    // text and drops the colour of Text inside it (why the marks were emoji until now). It is always drawn, so the label
    // never shifts when the state changes. A dim detail after the control (Auto's level, where Auto is a button) sits
    // beside it for the same reason: inside the Button the desktop would draw it at full strength.
    const withTip = (id: TipId, control: RenderChildren, dot?: string, detail?: string) => {
      const tip = ` ${shortTip(id, level)} `
      return (
        <Box key={`tip-${id}`} flexDirection="row" alignItems="center" columnGap="xs">
          {dot !== undefined && <Text size="caption" color={dot}>●</Text>}
          {control}
          {detail !== undefined && (
            <Text size="caption" dimColor>
              {detail}
            </Text>
          )}
          <Box position="absolute" top={-1} left={0} width={tip.length} display="none" hover={{ display: 'flex' }}>
            {/* The desktop draws its own tooltip box around the card; only the terminal needs inverse text to set it apart. */}
            <Text size="caption" inverse={e.surface === 'terminal' || undefined} wrap="truncate-end">
              {tip}
            </Text>
          </Box>
        </Box>
      )
    }
    // A meter: its dim name, the bar in its tone, the value in normal text (toned only once it warns), the detail dim,
    // each a caption space from the next.
    const gauge = (label: string, value: number, t: Tone, after = '', approx = false, section: 'context' | 'limits' = 'limits') => {
      const shown = `${approx ? '~' : ''}${Math.round(value)}%`
      // The terminal's cells are all one width, so a block and a shade measure the same.
      const blocks = bar(value, MINI_BAR)
      return (
        <Box flexDirection="row" alignItems="center">
          {opener(label, section)}
          {Svg && !padded && <Text size="caption">{' '}</Text>}
          {Svg ? (
            <Svg source={svgBar(value, t, BAND_BAR, 6)} alt={`${label} ${Math.round(value)}%`} width={BAND_BAR} height={6} />
          ) : (
            <Text size="caption">
              {' '}
              <Text color={t}>{blocks.fill}</Text>
              <Text color="subtle">{blocks.track}</Text>
            </Text>
          )}
          <Text size="caption">
            {' '}
            <Text color={valueTone(t)}>{shown}</Text>
            {after !== '' && ' '}
            {after !== '' && <Text dimColor>{after}</Text>}
          </Text>
        </Box>
      )
    }
    // A carried limit window goes at its reset time, even before the next reading comes.
    const fiveHour = drawn(s.fiveHour, now)
    const weekly = drawn(s.weekly, now)
    const parts = [
      s.context && gauge('Context', s.context.percent, ctxTone(s.context.percent), kTokens(s.context.tokens), s.context.estimated, 'context'),
      fiveHour && gauge('5h', fiveHour.percent, tone(fiveHour.percent), untilReset(fiveHour.resetsAt, now, true)),
      weekly && gauge('Week', weekly.percent, tone(weekly.percent), untilReset(weekly.resetsAt, now, true)),
      left !== undefined && (
        <Box flexDirection="row" alignItems="center">
          {opener('Cache', 'limits')}
          <Text size="caption">
            {!padded && ' '}
            <Text color={cacheTone(left)}>●</Text>{' '}
            <Text color={valueTone(cacheTone(left))}>{left > 0 ? `~${Math.ceil(left / 60000)}m` : 'cold?'}</Text>
          </Text>
        </Box>
      ),
      s.usd !== undefined && (
        <Box flexDirection="row" alignItems="center">
          {opener('Cost', 'limits')}
          <Text size="caption">
            {!padded && ' '}
            {`$${s.usd.toFixed(2)}`}
          </Text>
        </Box>
      ),
    ].filter(Boolean)

    const advice = ctxAdvice(pct, compacted)
    const handing = live && (await read($, handoffPending))
    const handedState = await read($, handedOff)
    const handed = handedState && now - handedState.at < NOTE_FOR_MS ? handedState.name : null
    const waiting = await read($, compactPlan)
    const claimed = await read($, compactingSince)
    const compactingNow = claimed !== null && now - claimed < COMPACT_TIMEOUT_MS
    const recent = await read($, lastNote)
    // A suggestion to hand off, never an action: Claude's own (suggest_new_session), or the mod's after two compactions,
    // since a summary of a summary loses more than a fresh start from the state page.
    const hint = await read($, handoffHint)
    const autoReason = compacted >= 2 ? 'compacted twice already' : ''
    const hintReason = hint?.reason || autoReason
    const suggestion = (why: string) => `Suggestion: a new session would serve better (${why}). Press New session.`
    const hintText = hintReason ? suggestion(hintReason) : ''
    const noteFresh = recent && now - recent.at < NOTE_FOR_MS && (!hint || recent.at > hint.at)

    // What is happening now, in one short line: a running step, then the overdue advice, then the newest of a proposed
    // session, a recent result, a suggestion, or the budget advice.
    const adviceLine = advice ? advice.charAt(0).toUpperCase() + advice.slice(1) + '.' : ''
    // A fresh note (a refusal, a button's result) stays above the overdue advice, so a press past it still shows what happened.
    // While Claude works on a check, a handoff or the compaction, the line is in Claude's orange, as its own working line is.
    // A line about a state a dot shows takes that dot's colour: green for a confirmed plan waiting, amber for a suggestion.
    const [status, statusTone] =
      compactingNow
        ? ['Compacting…', 'claude']
        : waiting && gaveUp === waiting
          ? [`Compaction did not start: press ${CHECK_NAME} to try again.`, 'error']
          : waiting && !pending
            ? ['Safe spot confirmed. Compacting when idle…', 'success']
            : pending
              ? ['Check running: Claude is testing for a safe spot…', 'claude']
              : handing
                ? ['Handoff running: safe-spot test, then the state page…', 'claude']
                : noteFresh && (!handed || recent.tone === 'error' || pct >= cfg.ctxOverdue)
                  ? [recent.text, recent.tone]
                  : pct >= cfg.ctxOverdue
                    ? [adviceLine, ctxTone(pct)]
                    : handed
                      ? [readyText(handed), 'success']
                      : noteFresh
                        ? [recent.text, recent.tone]
                        : hintText
                          ? [hintText, 'warning']
                          : [adviceLine, ctxTone(pct)]

    // A dot before each check button carries its state, so a refusal shows on the button itself: grey idle, Claude's
    // orange while Claude works on it (the check, the handoff, the compaction), green confirmed, red not safe or a
    // compaction that did not start, amber when a new session is suggested. Only Claude at work gets the spark and the
    // glowing line: a confirmed plan waiting for the session to go idle is green and still, as its dot is.
    const running = Boolean(pending || handing || compactingNow)
    const refused = noteFresh && recent.tone === 'error' ? recent.text : ''
    const checkDot =
      pending || compactingNow ? 'claude'
      : waiting && gaveUp === waiting ? 'error'
      : waiting ? 'success'
      : refused.startsWith('Not safe to compact') ? 'error'
      : 'inactive'
    const handoffDot = handing ? 'claude' : handed ? 'success' : refused.startsWith('Not safe to hand off') ? 'error' : hintReason ? 'warning' : 'inactive'
    const dismissed = await read($, dismissedStatus)
    const showStatus = status !== '' && status !== dismissed

    // Auto is a menu, as the footer's effort menu is: Off and the levels, the current one picked. Where the surface draws
    // no menu, it is the word as a plain button that steps through the same options, its level dim beside it.
    const autoControl = Select ? (
      <Select key="auto" label="Auto" options={autoOptions(level)} value={auto ? String(level) : 'off'} onSelect={picked => void pickAuto($, picked)} />
    ) : (
      <Button key="auto" label="Auto" plain onPress={() => void stepAuto($)} />
    )

    // The buttons keep one order and fixed words, so none moves when the status changes. Auto sits close beside Check &
    // compact, the button it presses for you; a wider gap, not a divider, sets the pair apart from New session and
    // Refresh. The status line below is drawn only when it has something to say, and × (right after the text) hides it
    // until the text changes. The meters are spaced by the row's own smallest gap, so a wrapped line starts level with Context.
    return (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="xs">
          {parts}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="lg">
          <Box flexDirection="row" alignItems="center" columnGap="xs">
            {withTip('check', <Button
              key="check"
              label={CHECK_NAME}
              plain
              // No letter hotkey: a click gives the band the focus, and a typed word must never start a model turn.
              // With a confirmed plan waiting, the same button compacts at once. Both outlast a button handler, so start from a timer.
              onPress={() =>
                void $.clock.after(200, () =>
                  void (waiting ? compactWhenIdle($, waiting, true) : startCheck($, 'Running the pre-compaction check…')),
                )
              }
            />, checkDot)}
            {withTip('auto', autoControl, undefined, Select ? undefined : auto ? `${level}%` : 'Off')}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap="xs">
            {withTip('handoff', <Button
              key="handoff"
              label="New session"
              plain
              onPress={() => void $.clock.after(200, () => void startHandoff($, 'Running the handoff check…'))}
            />, handoffDot)}
            {withTip('refresh', <Button
              key="refresh"
              label="Refresh"
              plain
              onPress={() => void $.clock.after(200, () => void refreshMods($))}
            />)}
          </Box>
        </Box>
        {showStatus && (
        <Box flexDirection="row" alignItems="center" columnGap="xs">
          {running &&
            (Svg ? (
              <Svg source={SPARK_SVG} alt="Running" width={12} height={12} />
            ) : (
              <Text size="caption" color="claude">✻</Text>
            ))}
          <Box flexShrink={1}>
            {running && Svg ? (
              <Svg source={glowSvg(status, statusTone)} alt={status} width={glowWidth(status)} height={GLOW_HEIGHT} />
            ) : (
              <Text size="caption" color={statusTone} wrap="truncate-end">
                {status}
              </Text>
            )}
          </Box>
          <Button
            key="dismiss"
            label="×"
            plain
            dimColor
            onPress={async () => {
              // Dismissing Claude's suggestion drops it and the older note it replaced; the two-compactions one keeps only its amber dot.
              if (status === hintText && hint) {
                await update($, lastNote, n => (n && n.at < hint.at ? null : n))
                await update($, handoffHint, () => null)
                await update($, dismissedStatus, () => (autoReason ? suggestion(autoReason) : status))
              } else {
                await update($, dismissedStatus, () => status)
              }
            }}
          />
        </Box>
        )}
      </Box>
    )
  })
}
