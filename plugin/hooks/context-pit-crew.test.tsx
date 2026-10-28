import { expect, mock, test } from 'claude-code/testing'
import type { UsageUnit } from 'claude-code'
import type { MockClock, TestBody } from 'claude-code/testing'

// Every wait in the mod runs on the kit's mocked clock, so a test moves time on instead of sleeping.
type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]
type Ctx = { tokens: number; window: number; percent: number }

const T0 = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60 * 1000

const reading = {
  context: { tokens: 412000, window: 1000000, percent: 41 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 82.5, resetsAt: '2099-01-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 31, resetsAt: '2099-01-01T00:00:00Z' },
  ],
  cost: { usd: 12.345 },
}

const PANE = {
  plugin: 'context-pit-crew',
  component: 'Pane',
  requestId: 'context-pit-crew',
  props: { title: 'Usage', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// What the world beneath the mod saw, and the knobs a test turns.
type World = {
  // The test's engine, so a queued /compact can run through the plugins' session.compact chain as the engine's does.
  engine?: Engine
  clock: MockClock
  ctx: Ctx
  prompts: { text: string; asUser: boolean; context: string }[]
  toasts: string[]
  runs: { command: string; args: string }[]
  compacts: string[]
  writes: { path: string; text: string }[]
  stored: Record<string, unknown>
  opens: number
  // session.compact throws this many times before it compacts, as the engine does while a turn winds down.
  compactRefusals: number
  // Whether a queued /compact runs (through the session.compact chain) before command.run settles.
  compactRuns: boolean
  reloadText: string
  // Holds a queued /compact until the test releases it, as the engine holds one until the session is idle.
  hold?: boolean
  release?: () => void
  tokensAfter?: number
  breakdown?: unknown
  noLimits?: boolean
  openFails?: boolean
  // The engine drops a prompt a plugin submits, with this reason (a reached limit).
  dropPrompt?: string
}

function world(on: On, ctx: Ctx, knobs: Partial<World> = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: T0 }),
    ctx,
    prompts: [],
    toasts: [],
    runs: [],
    compacts: [],
    writes: [],
    stored: {},
    opens: 0,
    compactRefusals: 0,
    compactRuns: true,
    reloadText: '',
    tokensAfter: 40000,
    ...knobs,
  }
  current = w
  on('command.register', () => ({ value: { command: 'pit-crew' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__context-pit-crew__${(e as { name: string }).name}` } }))
  on('store.get', (_, e) => ({ value: w.stored[(e as { key: string }).key] }))
  on('store.set', (_, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    w.stored[key] = value
    return { value: undefined }
  })
  on('ui.open', () => {
    w.opens++
    if (w.openFails) throw new Error('no surface')
    return { value: { isPlaced: true } }
  })
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      ...reading,
      ...(w.noLimits ? { rateLimits: [] } : {}),
      context: { ...w.ctx, ...(w.breakdown && (e as { breakdown?: string }).breakdown ? { breakdown: w.breakdown } : {}) },
    },
    // The one cast left: a test reading carries only the fields the mod reads, not a whole SessionUsage.
  }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: (e as { sessionId: string }).sessionId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('fs.write', (_, e) => {
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    if (w.dropPrompt !== undefined) return { drop: w.dropPrompt }
    w.prompts.push({ text: e.text, asUser: (e.origin as { asUser?: boolean }).asUser === true, context: (e.context ?? []).join('\n') })
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('tool.call', () => ({ result: 'unanswered' }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', async (_, e) => {
    w.runs.push({ command: e.command, args: e.args })
    // The engine runs a queued /compact through the session.compact chain before command.run settles.
    if (e.command === 'compact' && w.hold) await new Promise<void>(r => (w.release = r))
    if (e.command === 'compact' && w.compactRuns && w.engine) {
      await w.engine.session.compact({ trigger: 'manual', instructions: e.args, messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    }
    return { text: e.command === 'reload-plugins' ? w.reloadText : '' }
  })
  on('session.compact', (_, e) => {
    if (w.compactRefusals > 0) {
      w.compactRefusals--
      throw new Error('a turn is running')
    }
    w.compacts.push(e.instructions ?? '')
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], ...(w.tokensAfter !== undefined ? { tokensAfter: w.tokensAfter } : {}) }
  })
  return w
}

let current: World | undefined
const start = ($: Engine) => {
  if (current) current.engine = $
  return $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}
const measure = ($: Engine, w: World, changed: UsageUnit[] = ['context']) => $.session.measure({ ...reading, context: w.ctx, changed })
const bandProps = (isWorking: boolean) => ({ hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} })
const mountBand = ($: Engine, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'desktop', isWorking = false) =>
  $.ui.mount({ plugin: 'context-pit-crew', component: 'AbovePrompt', surface, props: bandProps(isWorking) })
type Band = Awaited<ReturnType<typeof mountBand>>
// The band on a surface that draws Auto's menu (the mobile app draws none), so the drawing can be picked from.
const mountMenuBand = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
  $.ui.mount({ plugin: 'context-pit-crew', component: 'AbovePrompt', surface, props: bandProps(false) })
// Picks a value from Auto's menu, as a person does: the ui.select chain, then the Select's own onSelect.
async function pickFromAuto($: Engine, value: string, surface: 'terminal' | 'desktop' = 'desktop') {
  const band = await mountMenuBand($, surface)
  await band.select({ key: 'auto', value })
  await band.unmount()
}
const tree = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'pit-crew', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const ask = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
// What the engine may raise after a typed slash command ran: the command's line, the command, and the composer's origin.
const typed = ($: Engine, name: string, args: string) =>
  $.prompt.submit({ text: `/${name} ${args}`, command: { name, args }, wait: false, origin: { kind: 'composer' } })
const tool = async ($: Engine, name: string, args: Record<string, unknown> = {}) =>
  String(((await $.tool.call({ tool: `mcp__context-pit-crew__${name}`, ...args })) as { result?: unknown }).result)
// Presses a band button and lets its 200 ms start timer run.
async function press($: Engine, w: World, key: string) {
  const band = await mountBand($)
  await band.press({ key })
  await band.unmount()
  await w.clock.advance(250)
}
// A turn as the desktop shows it: the band draws with isWorking on, then off. No turn.complete reaches mods there.
async function desktopTurn($: Engine, w: World, during?: () => Promise<unknown>) {
  const busy = await mountBand($, 'desktop', true)
  await busy.unmount()
  await during?.()
  const idle = await mountBand($, 'desktop', false)
  await idle.unmount()
  await w.clock.settle()
}
const label = (band: Band, text: RegExp) => band.find({ type: 'Button', text })
const statusIs = (band: Band, text: RegExp) => band.find({ type: 'Text', text })
// The theme colour of the state dot drawn first in a check button's keyed Box: inactive idle, claude running,
// success confirmed, error not safe, warning a new session suggested.
const dotOf = async (band: Band, id: 'check' | 'handoff') =>
  new RegExp(`"key":"tip-${id}"[^}]*\\},"children":\\[\\{"type":"Text","props":\\{"size":"caption","color":"(\\w+)"\\},"children":\\["●"\\]\\}`).exec(await tree(band))?.[1]
// Claude Code's look, held on every drawing: no emoji and no divider glyphs anywhere.
const NOT_CLAUDE_LOOK = /\p{Extended_Pictographic}|[│|]/u
// Every Text size drawn in a row of the band, the floating tip cards left out (they sit over the band, not in a row).
// A Text nested in another takes the outer one's size unless it sets its own, as a surface draws it.
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
function sizesIn(node: unknown, found: Set<string> = new Set(), inherited = 'body'): Set<string> {
  if (typeof node !== 'object' || node === null) return found
  const n: Node = node
  if (n.props?.position === 'absolute') return found
  const size = n.type === 'Text' ? String(n.props?.size ?? inherited) : inherited
  if (n.type === 'Text') found.add(size)
  for (const child of n.children ?? []) sizesIn(child, found, size)
  return found
}
// The band's rows, as drawn: the meters, the buttons, and the status line when there is one.
async function rows(band: Band): Promise<unknown[]> {
  const root: Node = JSON.parse(await tree(band))
  return root.children ?? []
}
// What Auto reads: on a surface with a menu, its label and the picked option's label; where Auto is a button (the
// mobile app), its label and the dim level drawn after it in the same keyed Box (the tip card left out).
// A drawn element as a Node, or an empty one for anything that is not an element (a string, a dropped child).
function node(x: unknown): Node {
  return typeof x === 'object' && x !== null ? x : {}
}
// A drawn Select's options, as plain value and label pairs.
function optionsOf(found: { props: Record<string, unknown> } | undefined): { value: string; label: string }[] {
  const list: unknown = found?.props.options
  if (!Array.isArray(list)) return []
  return list.map((o: unknown) => ({
    value: typeof o === 'object' && o !== null && 'value' in o ? String(o.value) : '',
    label: typeof o === 'object' && o !== null && 'label' in o ? String(o.label) : '',
  }))
}
async function autoReads(band: Band): Promise<string> {
  const menu = await band.find({ type: 'Select', key: 'auto' })
  if (menu) {
    const picked = optionsOf(menu).find(o => o.value === menu.props.value)
    return `${String(menu.props.label)} ${picked?.label ?? '?'}`
  }
  const shown: string[] = []
  for (const child of (await band.find({ type: 'Box', key: 'tip-auto' }))?.children ?? []) {
    if (typeof child !== 'object' || child === null) continue
    const n: Node = child
    if (n.type === 'Button') shown.push(String(n.props?.label))
    if (n.type === 'Text' && n.props?.dimColor === true) shown.push(String(n.children?.[0]))
  }
  return shown.join(' ')
}
// The meter row as the terminal lays it out: each meter's text run together (a Button is its label alone there), the
// meters a gap step apart, at the terminal's cells for each step (xs and sm 1, md 2, lg 3, xl 4).
const CELLS: Record<string, number> = { xs: 1, sm: 1, md: 2, lg: 3, xl: 4 }
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const n: Node = node
  if (n.type === 'Button') return String(n.props?.label ?? '')
  return (n.children ?? []).map(textOf).join('')
}
async function terminalMeterLine(band: Band): Promise<string> {
  const row = node((await rows(band))[0])
  const gap = ' '.repeat(CELLS[String(row.props?.columnGap)] ?? 0)
  return (row.children ?? []).map(textOf).join(gap)
}
// The theme colours as the desktop's SVG carries them (the bars, the spark, the glowing running line).
const HEX: Record<string, string> = { suggestion: '#407bd9', warning: '#fbbf24', error: '#f87171', success: '#4ade80', claude: '#d97757' }
// The status line's colour: a Text's theme colour, or on the desktop the glowing line's colour while Claude works.
async function lineTone(band: Band, text: RegExp): Promise<string | undefined> {
  const line = await band.find({ type: 'Text', text })
  if (line) return String(line.props.color)
  const glow = (await band.findAll({ type: 'Svg' })).find(s => text.test(String(s.props.alt)))
  return glow && Object.keys(HEX).find(k => String(glow.props.source).includes(`stop-color="${HEX[k]}"`))
}
// Claude's working mark beside the status line: the ✻ on the terminal, the turning spark on the desktop.
const sparkShown = async (band: Band) =>
  Boolean((await band.find({ type: 'Text', text: '✻' })) ?? (await band.findAll({ type: 'Svg' })).find(s => s.props.alt === 'Running'))
const READY = { state_page: '/p/STATUS.md', next_step: 'run wave 3', background_tasks: 'w1 review' }

test('the pane shows context, both limits and cost on every surface', async ($, on) => {
  const w = world(on, reading.context)
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /412k of 1M tokens/ }))?.text).toBe('412k of 1M tokens · watch for the next good spot')
    expect(await ui.find({ type: 'Text', text: /^82\.5%$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^31%$/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /\$12\.35/ }))?.text).toBe('$12.35')
    // The terminal resolves Svg but draws it empty, so it gets block bars instead.
    expect(Boolean(await ui.find({ type: 'Text', text: /█/ }))).toBe(surface === 'terminal')
    await ui.unmount()
  }
  w.ctx = { tokens: 999600, window: 1000000, percent: 99.96 }
  await measure($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^1M of 1M tokens/ })).toBeTruthy()
  await ui.unmount()
})

test('nudges: one per line, each yields to the user, none creates a page unasked, and each names a real button', async ($, on) => {
  const w = world(on, { tokens: 520000, window: 1000000, percent: 52 })
  await start($)
  await measure($, w)
  await ask($, 'one')
  expect(w.prompts[0]?.context).toMatch(/Context is at 52%\. Do what the user asks first\. If this session keeps a start-here state page/)
  expect(w.prompts[0]?.context).toMatch(/do not create one unasked/)
  expect(w.prompts[0]?.context).not.toMatch(/suggest_new_session/)
  await ask($, 'two')
  expect(w.prompts[1]?.context).toBe('')

  w.ctx = { tokens: 640000, window: 1000000, percent: 64 }
  await measure($, w)
  await ask($, 'three')
  const sixty = w.prompts[2]?.context ?? ''
  expect(sixty).toMatch(/Do what the user asks first/)
  // The nudge names the button exactly as the band draws it.
  const named = sixty.match(/press (.+?) in the Context Pit Crew band/)?.[1] ?? ''
  expect(named).toBe('Check & compact')
  const band = await mountBand($)
  expect(await dotOf(band, 'check')).toBe('inactive')
  await band.unmount()
  expect(sixty).toMatch(/moved to a topic unrelated/)
  expect(sixty).not.toMatch(/stale tool output/)

  w.ctx = { tokens: 800000, window: 1000000, percent: 80 }
  await measure($, w)
  await ask($, 'four')
  expect(w.prompts[3]?.context).toMatch(/80%, past the overdue line\. Do what the user asks; before starting long multi-step work/)
  expect(w.prompts[3]?.context).not.toMatch(/start no new multi-step work/)
})

test('a compaction the mod did not start gets the keep line but no after-compaction note', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await measure($, w)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  expect(w.compacts[0]).toMatch(/Keep: the path of the start-here state page, if this session has one; pending user decisions/)
  expect(w.compacts[0]).not.toMatch(/read it first/)
  expect(w.compacts[0]).not.toMatch(/STATUS\.md/)
  await ask($, 'next question')
  expect(w.prompts[0]?.context).not.toMatch(/compacted/)
})

test("the notes ride your next message, not a notification, a peer, a schedule or another plugin's prompt", async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  // A compaction the mod ran, then a context line crossed: both notes are due.
  await press($, w, 'check')
  await desktopTurn($, w, () => tool($, 'ready_to_compact', READY))
  await w.clock.advance(2000)
  expect(w.compacts.length).toBe(1)
  w.ctx = { tokens: 640000, window: 1000000, percent: 64 }
  await measure($, w)
  const lastContext = () => w.prompts[w.prompts.length - 1]?.context
  const notUser = [
    { kind: 'task-notification' },
    { kind: 'scheduled-trigger' },
    { kind: 'peer' },
    { kind: 'plugin', name: 'other-plugin' },
  ] as const
  for (const origin of notUser) {
    await $.prompt.submit({ text: 'something arrived', wait: false, origin })
    expect(lastContext()).toBe('')
  }
  await $.prompt.submit({ text: 'an idle notice', wait: false, origin: { kind: 'unclassified' }, isMeta: true })
  expect(lastContext()).toBe('')
  // A plugin that sends the words as the person's own is the person's message, and the notes, still due, ride it.
  await $.prompt.submit({ text: 'what the person typed', wait: false, origin: { kind: 'plugin', name: 'other-plugin', asUser: true } })
  expect(lastContext()).toMatch(/Answer the user's message first/)
  expect(lastContext()).toMatch(/good time to press Check & compact/)
  await ask($, 'and then')
  expect(lastContext()).toBe('')
})

test('Check & compact, pressed: only a passing check compacts, once, with what Claude reported, and says so after it ran', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await measure($, w)
  expect(await tool($, 'ready_to_compact', READY)).toMatch(/Refused/)

  await press($, w, 'check')
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]?.text).toMatch(/^Pre-compaction check \(the user pressed Check & compact in the Context Pit Crew band; "I" and "me" below mean the user\)/)
  expect(w.prompts[0]?.text).toMatch(/park it: write a note of where it stands .* do not finish it/)
  expect(w.prompts[0]?.text).not.toMatch(/finish or park/)
  let band = await mountBand($)
  expect(await dotOf(band, 'check')).toBe('claude')
  await band.unmount()

  // A second press while the check runs starts nothing.
  await press($, w, 'check')
  expect(w.prompts.length).toBe(1)
  expect(w.toasts.some(t => /already running/.test(t))).toBe(true)

  await desktopTurn($, w, async () => {
    expect(await tool($, 'ready_to_compact', READY)).toMatch(/Recorded/)
    // The engine measures as the turn ends.
    await measure($, w)
  })
  band = await mountBand($)
  // A waiting plan is a still green line, as its dot is: Claude is not at work while the session goes idle.
  expect(await lineTone(band, /^Safe spot confirmed\. Compacting when idle…$/)).toBe('success')
  expect(await sparkShown(band)).toBe(false)
  // Pressing again while the plan waits compacts it at once, and the scheduled compaction then finds it taken.
  await band.press({ key: 'check' })
  await band.unmount()
  await w.clock.advance(2000)
  expect(w.runs.filter(r => r.command === 'compact').length).toBe(1)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0]).toMatch(/^State page: \/p\/STATUS\.md \(read it before continuing the earlier work\)\..*w1 review.*run wave 3.*\(Context Pit Crew plan\)$/)
  // The mod's own plan is not given a second keep line.
  expect(w.compacts[0]).not.toMatch(/Keep:/)

  band = await mountBand($)
  expect(await statusIs(band, /^Compacted\. Context now ~4%\.$/)).toBeTruthy()
  expect(await dotOf(band, 'check')).toBe('inactive')
  await band.unmount()
  await ask($, 'and now?')
  expect(w.prompts[w.prompts.length - 1]?.context).toMatch(/Answer the user's message first/)
})

test('the command says it was the command, not a press', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await run($, 'check')
  await w.clock.advance(400)
  expect(w.prompts[0]?.text).toMatch(/^Pre-compaction check \(the user ran \/pit-crew check;/)
  await ask($, 'never mind')
  await run($, 'handoff')
  await w.clock.advance(400)
  expect(w.prompts[w.prompts.length - 1]?.text).toMatch(/^Hand this work off to a fresh session \(I ran \/pit-crew handoff\)/)
})

test('a session with no state page compacts on a plan that says so', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await press($, w, 'check')
  await desktopTurn($, w, () => tool($, 'ready_to_compact', { state_page: 'There is no state page.', next_step: 'go' }))
  await w.clock.advance(2000)
  expect(w.compacts[0]).toMatch(/^This session keeps no state page\. /)
})

test('a /compact that does not run is retried through the session, and a refusal there is retried too', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 }, { compactRuns: false, compactRefusals: 2 })
  await start($)
  await press($, w, 'check')
  await desktopTurn($, w, () => tool($, 'ready_to_compact', READY))
  await w.clock.advance(1100)
  let band = await mountBand($)
  expect(await statusIs(band, /^Compacting…$/)).toBeFalsy()
  expect(await tree(band)).toMatch(/"alt":"Compacting…"/)
  await band.unmount()
  await w.clock.advance(5000)
  expect(w.runs.filter(r => r.command === 'compact').length).toBe(1)
  expect(w.compacts.length).toBe(1)
  // The mod's own $.session.compact skips its own hook, so the mod records it itself: the line, the count and the note.
  band = await mountBand($)
  expect(await tree(band)).not.toMatch(/Compacting…/)
  expect(await statusIs(band, /^Compacted\. Context now ~4%\.$/)).toBeTruthy()
  await band.unmount()
  await ask($, 'next')
  expect(w.prompts[w.prompts.length - 1]?.context).toMatch(/Answer the user's message first/)
})

test('a queued /compact whose plan a typed message dropped is vetoed when it runs', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 }, { hold: true })
  await start($)
  await press($, w, 'check')
  await desktopTurn($, w, () => tool($, 'ready_to_compact', READY))
  await w.clock.advance(1100)
  expect(w.runs.filter(r => r.command === 'compact').length).toBe(1)
  await ask($, 'wait, one more thing')
  w.release?.()
  await w.clock.advance(5000)
  expect(w.compacts.length).toBe(0)
  const band = await mountBand($)
  expect(await tree(band)).not.toMatch(/Compacted|Compacting/)
  await band.unmount()
})

test('a check never queues a compaction mid-turn, and a stopped turn drops the plan it confirmed', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await press($, w, 'check')
  const busy = await mountBand($, 'desktop', true)
  await busy.unmount()
  await tool($, 'ready_to_compact', READY)
  await measure($, w)
  await w.clock.advance(5000)
  expect(w.runs.filter(r => r.command === 'compact').length).toBe(0)
  // The terminal reports the stop: nothing compacts.
  await $.turn.complete({ turnId: 't', reason: 'aborted', answer: '', durationMs: 1000, isAborted: true })
  const idle = await mountBand($, 'desktop', false)
  await idle.unmount()
  await w.clock.advance(5000)
  expect(w.runs.filter(r => r.command === 'compact').length).toBe(0)
  const band = await mountBand($)
  expect(await statusIs(band, /^The turn was stopped, so the confirmed compaction was dropped\.$/)).toBeTruthy()
  await band.unmount()
})

// A confirmed plan mid-turn, then the terminal says why the turn ended: nothing compacts, and the band says why.
async function planThenTurnEnds($: Engine, w: World, end: () => Promise<unknown>, said: RegExp) {
  await press($, w, 'check')
  const busy = await mountBand($, 'desktop', true)
  await busy.unmount()
  await tool($, 'ready_to_compact', READY)
  await measure($, w)
  await w.clock.advance(5000)
  await end()
  const idle = await mountBand($, 'desktop', false)
  await idle.unmount()
  await w.clock.advance(5000)
  expect(w.runs.filter(r => r.command === 'compact').length).toBe(0)
  expect(w.compacts.length).toBe(0)
  const band = await mountBand($)
  expect(await statusIs(band, said)).toBeTruthy()
  await band.unmount()
}

test('a turn that ends in an error drops the plan it confirmed, and the band says so, not "stopped"', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await planThenTurnEnds($, w, () => $.turn.complete({ turnId: 't', reason: 'error', answer: '', durationMs: 1000, isAborted: false }), /^The turn ended with an error, so the confirmed compaction was dropped\.$/)
})

test('a turn the model refused drops the plan it confirmed, and the band says so', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await planThenTurnEnds(
    $,
    w,
    () => $.turn.complete({ turnId: 't', reason: 'refusal', refusal: { category: null, explanation: null }, answer: '', durationMs: 1000, isAborted: false }),
    /^The turn was refused by the model, so the confirmed compaction was dropped\.$/,
  )
})

test('typing a message stops the retries; after the last retry the plan waits for a press, and nothing sticks', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 }, { compactRuns: false, compactRefusals: 1000 })
  await start($)
  await press($, w, 'check')
  await desktopTurn($, w, () => tool($, 'ready_to_compact', READY))
  await w.clock.advance(1100 + 41 * 1500 + 1000)
  expect(w.toasts.some(t => /The compaction did not start\. Press Check & compact to try again/.test(t))).toBe(true)
  expect(w.toasts.some(t => /Compact now/.test(t))).toBe(false)
  let band = await mountBand($)
  // The dot is red with its line, not green beside a red line; the plan still waits for a press.
  expect(await dotOf(band, 'check')).toBe('error')
  expect(await lineTone(band, /^Compaction did not start: press Check & compact to try again\.$/)).toBe('error')
  expect(await sparkShown(band)).toBe(false)
  await band.unmount()
  // New session waits for the confirmed compaction instead of racing it.
  const prompted = w.prompts.length
  await press($, w, 'handoff')
  expect(w.prompts.length).toBe(prompted)
  expect(w.toasts.some(t => /A confirmed compaction is waiting/.test(t))).toBe(true)

  // Now the session is free: a press compacts the waiting plan at once, with no new check.
  w.compactRefusals = 0
  const before = w.prompts.length
  await press($, w, 'check')
  await w.clock.advance(2000)
  expect(w.prompts.length).toBe(before)
  expect(w.compacts.length).toBe(1)

  // A second plan whose retries a typed message stops.
  w.compactRefusals = 1000
  await press($, w, 'check')
  await desktopTurn($, w, () => tool($, 'ready_to_compact', READY))
  await w.clock.advance(1100 + 3 * 1500)
  const tries = w.runs.length
  await ask($, 'actually, wait')
  // The session is free now, so a retry that still ran would compact over the question; none may.
  w.compactRefusals = 0
  await w.clock.advance(20 * 1500)
  band = await mountBand($)
  expect(await tree(band)).not.toMatch(/Compacting/)
  await band.unmount()
  expect(w.compacts.length).toBe(1)
  expect(w.runs.length).toBe(tries)
})

test('typing a message abandons a running check: a late ready_to_compact cannot compact over the question', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await press($, w, 'check')
  await ask($, 'a new question')
  expect(await tool($, 'ready_to_compact', READY)).toMatch(/Refused/)
  await measure($, w)
  await w.clock.advance(5000)
  expect(w.runs.some(r => r.command === 'compact')).toBe(false)
  expect(w.compacts.length).toBe(0)
})

test('a typed /pit-crew command is not a new message: it keeps a running check and a waiting plan', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 }, { compactRuns: false, compactRefusals: 1000 })
  await start($)
  // The engine may raise prompt.submit for a typed command, after command.run, with the composer's origin.
  await press($, w, 'check')
  await run($, 'help')
  await typed($, 'pit-crew', 'help')
  expect(await tool($, 'ready_to_compact', READY)).toMatch(/Recorded/)
  // The plan's retries run out, so it waits; then the command compacts it, and its own prompt.submit does not drop it first.
  await desktopTurn($, w)
  await w.clock.advance(1100 + 41 * 1500 + 1000)
  expect(w.compacts.length).toBe(0)
  w.compactRefusals = 0
  await run($, 'check')
  await typed($, 'pit-crew', 'check')
  await w.clock.advance(2000)
  expect(w.compacts.length).toBe(1)
  // Any other typed command is a new message: it abandons a running check.
  await press($, w, 'check')
  await typed($, 'review', 'the diff')
  expect(await tool($, 'ready_to_compact', READY)).toMatch(/Refused/)
})

test('a measurement mid-check ends nothing; a check whose turn ends with no verdict is over', async ($, on) => {
  const w = world(on, { tokens: 400000, window: 1000000, percent: 40 })
  await start($)
  await press($, w, 'check')
  // The check's own turn: a mid-turn measurement leaves it running.
  const busy = await mountBand($, 'desktop', true)
  await busy.unmount()
  await measure($, w)
  await w.clock.advance(1000)
  let band = await mountBand($, 'desktop', true)
  expect(await dotOf(band, 'check')).toBe('claude')
  expect(await tree(band)).toMatch(/"alt":"Running"/)
  expect(await tree(band)).toMatch(/"alt":"Check running: Claude is testing for a safe spot…"/)
  await band.unmount()
  // A long check turn is not dropped by the 10-minute timer while it still runs.
  await w.clock.advance(11 * MIN)
  band = await mountBand($, 'desktop', true)
  expect(await dotOf(band, 'check')).toBe('claude')
  await band.unmount()
  // Claude answers without either tool (it asked something): the turn's end closes the check.
  band = await mountBand($, 'desktop', false)
  await band.unmount()
  await w.clock.settle()
  band = await mountBand($)
  expect(await statusIs(band, /^Check ended without a verdict: Claude's reply says why\.$/)).toBeTruthy()
  expect(await dotOf(band, 'check')).toBe('inactive')
  expect(await tree(band)).not.toMatch(/"alt":"Running"/)
  await band.unmount()
  expect(await tool($, 'ready_to_compact', READY)).toMatch(/Refused/)
})

test('a check with no verdict and no turn end is dropped after ten minutes', async ($, on) => {
  const w = world(on, { tokens: 400000, window: 1000000, percent: 40 })
  await start($)
  await press($, w, 'check')
  await w.clock.advance(9 * MIN)
  let band = await mountBand($)
  expect(await dotOf(band, 'check')).toBe('claude')
  await band.unmount()
  await w.clock.advance(2 * MIN)
  band = await mountBand($)
  expect(await dotOf(band, 'check')).toBe('inactive')
  expect(await statusIs(band, /^No verdict after 10 minutes/)).toBeTruthy()
  await band.unmount()
  // And the button works again.
  await press($, w, 'check')
  expect(w.prompts.length).toBe(2)
})

test('a check or handoff prompt the engine drops ends at once, with the reason, and frees the buttons', async ($, on) => {
  // The engine's reason may already end in a full stop; the band's line does not double it.
  const w = world(on, { tokens: 400000, window: 1000000, percent: 40 }, { dropPrompt: 'usage limit reached.' })
  await start($)
  await press($, w, 'check')
  let band = await mountBand($)
  expect(await statusIs(band, /^The check did not start: usage limit reached\.$/)).toBeTruthy()
  expect(await dotOf(band, 'check')).toBe('inactive')
  expect(await tree(band)).not.toMatch(/"alt":"Running"/)
  await band.unmount()
  // Nothing is left running, so Refresh reloads, and a late tool call is refused.
  expect(await tool($, 'ready_to_compact', READY)).toMatch(/Refused/)
  await press($, w, 'refresh')
  expect(w.runs.some(r => r.command === 'reload-plugins')).toBe(true)
  // The same for the handoff, and a reason without a full stop gets one.
  w.dropPrompt = 'usage limit reached'
  await press($, w, 'handoff')
  band = await mountBand($)
  expect(await statusIs(band, /^The handoff did not start: usage limit reached\.$/)).toBeTruthy()
  expect(await dotOf(band, 'handoff')).toBe('inactive')
  await band.unmount()
  // A drop with no reason still says something.
  w.dropPrompt = ''
  await press($, w, 'check')
  band = await mountBand($)
  expect(await statusIs(band, /^The check did not start: the prompt was dropped\.$/)).toBeTruthy()
  await band.unmount()
  // Once the engine takes prompts again, the buttons work.
  w.dropPrompt = undefined
  await press($, w, 'check')
  expect(w.prompts.length).toBe(1)
})

test('a failed check says why at once; the dot turns red; × hides the line until a compaction', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  expect(await tool($, 'not_safe_to_compact', { reason: 'x' })).toMatch(/no check or handoff is running/)
  await press($, w, 'check')
  await tool($, 'not_safe_to_compact', { reason: 'an approval is waiting on you.' })
  let band = await mountBand($)
  expect(await statusIs(band, /^Not safe to compact: an approval is waiting on you\.$/)).toBeTruthy()
  expect(await dotOf(band, 'check')).toBe('error')
  expect(await tree(band)).not.toMatch(/"alt":"Running"/)
  await band.press({ key: 'dismiss' })
  await band.unmount()
  band = await mountBand($)
  expect(await tree(band)).not.toMatch(/Not safe to compact/)
  await band.unmount()
  expect(await tool($, 'ready_to_compact', READY)).toMatch(/Refused/)
  expect(w.compacts.length).toBe(0)
  // A new refusal in the same words is news: it is drawn although the old one was dismissed.
  await w.clock.advance(1000)
  await press($, w, 'check')
  await tool($, 'not_safe_to_compact', { reason: 'an approval is waiting on you' })
  band = await mountBand($)
  expect(await statusIs(band, /^Not safe to compact: an approval is waiting on you\.$/)).toBeTruthy()
  await band.press({ key: 'dismiss' })
  await band.unmount()

  // The advice line, dismissed, comes back after a compaction.
  await w.clock.advance(11 * MIN)
  band = await mountBand($)
  expect(await statusIs(band, /^Compact at the next good spot\.$/)).toBeTruthy()
  await band.press({ key: 'dismiss' })
  await band.unmount()
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  w.ctx = { tokens: 650000, window: 1000000, percent: 65 }
  await measure($, w)
  await w.clock.advance(11 * MIN)
  band = await mountBand($)
  expect(await statusIs(band, /^Compact at the next good spot\.$/)).toBeTruthy()
  await band.unmount()
})

test('Auto waits for the turn to end on the desktop, and never starts from a measurement mid-turn', async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  const autos = () => w.prompts.filter(p => /Auto setting/.test(p.text))
  // From Off, a pick from the menu turns Auto on at that level.
  await pickFromAuto($, '50')
  expect(w.stored.autoCheck).toBe(true)
  expect(w.stored.autoAt).toBe(50)
  let band = await mountBand($)
  expect(await autoReads(band)).toBe('Auto 50%')
  await band.unmount()

  // Mid-turn measurements: nothing starts.
  const busy = await mountBand($, 'desktop', true)
  await busy.unmount()
  await measure($, w)
  await w.clock.advance(5000)
  expect(w.prompts.length).toBe(0)
  // The turn ends, and you type a reply within Auto's short wait, as people do: your message wins this turn's end.
  band = await mountBand($, 'desktop', false)
  await band.unmount()
  await w.clock.advance(500)
  await ask($, 'one more thing')
  await w.clock.advance(2000)
  expect(autos().length).toBe(0)
  // That did not spend Auto: the reply's turn ends past the level, and the check starts on its own, not in the user's name.
  await desktopTurn($, w)
  await w.clock.advance(2000)
  expect(autos().length).toBe(1)
  expect(autos()[0]?.text).toMatch(/started by the Context Pit Crew Auto setting/)
  expect(autos()[0]?.asUser).toBe(false)
  // Claude refuses; Auto does not try again before a compaction.
  await desktopTurn($, w, () => tool($, 'not_safe_to_compact', { reason: 'mid-edit' }))
  await desktopTurn($, w)
  await w.clock.advance(5000)
  expect(autos().length).toBe(1)

  // Each pick sets its level and keeps Auto on; Off turns it off.
  for (const at of [60, 70, 80]) {
    await pickFromAuto($, String(at), at === 70 ? 'terminal' : 'desktop')
    expect(w.stored.autoAt).toBe(at)
    expect(w.stored.autoCheck).toBe(true)
  }
  await pickFromAuto($, 'off')
  expect(w.stored.autoCheck).toBe(false)
  band = await mountBand($)
  expect(await autoReads(band)).toBe('Auto Off')
  await band.unmount()
})

test("a turn that starts inside Auto's wait wins it by the band alone, and the run comes back", async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  await run($, 'auto on')
  await measure($, w)
  const autos = () => w.prompts.filter(p => /Auto setting/.test(p.text))
  await desktopTurn($, w)
  await w.clock.advance(500)
  // The desktop may stamp a typed prompt 'unclassified', so nothing in the prompt hook ends Auto's wait: only the band
  // drawn with isWorking on, inside the wait, keeps Auto off a turn you started.
  await $.prompt.submit({ text: 'one more thing', wait: false, origin: { kind: 'unclassified' } })
  const busy = await mountBand($, 'desktop', true)
  await busy.unmount()
  await w.clock.advance(2000)
  expect(autos().length).toBe(0)
  // The wait gave the run back: the end of that turn starts Auto, as itself.
  const idle = await mountBand($, 'desktop', false)
  await idle.unmount()
  await w.clock.advance(2000)
  expect(autos().length).toBe(1)
  expect(autos()[0]?.asUser).toBe(false)
})

test("a stop that reaches Auto's wait late wins it on the terminal, and the next answered turn runs Auto", async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  await run($, 'auto on')
  await measure($, w)
  const autos = () => w.prompts.filter(p => /Auto setting/.test(p.text))
  // The terminal's band can see the turn end before turn.complete says it was stopped: Auto's wait has started by then.
  await ask($, 'do the thing')
  let band = await mountBand($, 'terminal', true)
  await band.unmount()
  band = await mountBand($, 'terminal', false)
  await band.unmount()
  await w.clock.advance(500)
  await $.turn.complete({ turnId: 't', reason: 'aborted', answer: '', durationMs: 1000, isAborted: true })
  await w.clock.advance(2000)
  expect(autos().length).toBe(0)
  // The wait gave the run back: the next answered turn starts Auto.
  await ask($, 'go on')
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false })
  await w.clock.advance(2000)
  expect(autos().length).toBe(1)
})

test("a reload inside Auto's wait gives its run back; a reload after its check keeps the run spent", async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  await run($, 'auto on')
  await measure($, w)
  const autos = () => w.prompts.filter(p => /Auto setting/.test(p.text))
  // A reload kills the wait's timer (here session.start ends it): the turn's end, then the reload, then nothing runs.
  await desktopTurn($, w)
  await w.clock.advance(500)
  await start($)
  await w.clock.advance(2000)
  expect(autos().length).toBe(0)
  // The run came back with it: the next turn's end starts Auto.
  await desktopTurn($, w)
  await w.clock.advance(2000)
  expect(autos().length).toBe(1)
  // Claude refuses, the mods reload, and Auto still does not repeat a check Claude just refused.
  await desktopTurn($, w, () => tool($, 'not_safe_to_compact', { reason: 'mid-edit' }))
  await start($)
  await desktopTurn($, w)
  await w.clock.advance(5000)
  expect(autos().length).toBe(1)
})

test('Auto never runs after a manual check was refused, nor after a stopped turn', async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  await run($, 'auto on')
  await press($, w, 'check')
  await desktopTurn($, w, () => tool($, 'not_safe_to_compact', { reason: 'mid-edit' }))
  await w.clock.advance(5000)
  expect(w.prompts.length).toBe(1)

  // On the terminal turn.complete says a turn was stopped; Auto stays quiet even with its cycle re-armed.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  w.ctx = { tokens: 700000, window: 1000000, percent: 70 }
  await measure($, w)
  await ask($, 'do the thing')
  await $.turn.complete({ turnId: 't', reason: 'aborted', answer: '', durationMs: 1000, isAborted: true })
  await w.clock.advance(5000)
  expect(w.prompts.filter(p => /Auto setting/.test(p.text)).length).toBe(0)
  // The next answered turn runs it.
  await ask($, 'go on')
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false })
  await w.clock.advance(2000)
  expect(w.prompts.filter(p => /Auto setting/.test(p.text)).length).toBe(1)
})

test('after two compactions Auto runs the handoff instead, not as the user; the button press is the user\'s', async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  await run($, 'auto on')
  for (const _ of [1, 2]) await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  w.ctx = { tokens: 700000, window: 1000000, percent: 70 }
  await measure($, w)
  await desktopTurn($, w)
  await w.clock.advance(2000)
  const auto = w.prompts.find(p => /Hand this work off/.test(p.text))
  expect(auto?.text).toMatch(/Context Pit Crew Auto setting/)
  expect(auto?.text).not.toMatch(/I pressed/)
  expect(auto?.asUser).toBe(false)

  await ask($, 'stop')
  await press($, w, 'handoff')
  const pressed = w.prompts[w.prompts.length - 1]
  expect(pressed?.text).toMatch(/I pressed New session/)
  expect(pressed?.asUser).toBe(true)
  // The initiation it asks for is explained by the app's rule, not by denying the user asked.
  expect(pressed?.text).toMatch(/initiation "own_initiative" \(the app starts a session only on words typed in the prompt box/)
  expect(pressed?.text).not.toMatch(/not the user's own words/)
})

test('New session: ready only after a passing handoff; the line clears on a typed message and after ten minutes', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  const handed = { state_page: '/p/STATUS.md', new_session: 'Continue: wave 3' }
  expect(await tool($, 'ready_to_hand_off', handed)).toMatch(/Refused/)
  await press($, w, 'handoff')
  expect(w.prompts[0]?.text).toMatch(/fresh session.*start_session/s)
  let running = await mountBand($, 'desktop', true)
  expect(await dotOf(running, 'handoff')).toBe('claude')
  expect(await tree(running)).toMatch(/"alt":"Handoff running: safe-spot test, then the state page…"/)
  await running.unmount()
  await desktopTurn($, w, () => tool($, 'ready_to_hand_off', handed))
  let band = await mountBand($)
  expect(await statusIs(band, /^New session ready: click the "Continue: wave 3" card to start it\.$/)).toBeTruthy()
  expect(await dotOf(band, 'handoff')).toBe('success')
  await band.unmount()
  expect(w.toasts.filter(t => /New session ready/.test(t)).length).toBe(1)

  await ask($, 'one more thing first')
  band = await mountBand($)
  expect(await tree(band)).not.toMatch(/New session ready/)
  expect(await dotOf(band, 'handoff')).toBe('inactive')
  await band.unmount()

  // Again, left alone: it lapses after ten minutes.
  await press($, w, 'handoff')
  await desktopTurn($, w, () => tool($, 'ready_to_hand_off', handed))
  band = await mountBand($)
  expect(await statusIs(band, /^New session ready/)).toBeTruthy()
  await band.unmount()
  await w.clock.advance(11 * MIN)
  band = await mountBand($)
  expect(await tree(band)).not.toMatch(/New session ready/)
  await band.unmount()
})

test('past the overdue line a fresh refusal still shows, with its red dot', async ($, on) => {
  const w = world(on, { tokens: 800000, window: 1000000, percent: 80 })
  await start($)
  await press($, w, 'check')
  await tool($, 'not_safe_to_compact', { reason: 'mid-edit' })
  let band = await mountBand($)
  expect(await statusIs(band, /^Not safe to compact: mid-edit\.$/)).toBeTruthy()
  expect(await dotOf(band, 'check')).toBe('error')
  await band.unmount()
  await w.clock.advance(11 * MIN)
  band = await mountBand($)
  expect(await statusIs(band, /^Overdue: park the current step and compact\.$/)).toBeTruthy()
  await band.unmount()
})

test('past the overdue line the advice outranks a proposed new session', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  await press($, w, 'handoff')
  await desktopTurn($, w, () => tool($, 'ready_to_hand_off', { state_page: '/p', new_session: 'Continue: x' }))
  w.ctx = { tokens: 800000, window: 1000000, percent: 80 }
  await measure($, w)
  const band = await mountBand($)
  expect(await statusIs(band, /^Overdue: park the current step and compact\.$/)).toBeTruthy()
  await band.unmount()
})

test('a /clear starts the conversation state over', async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  await run($, 'auto on')
  for (const _ of [1, 2]) await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  await press($, w, 'check')
  // The engine's last figure for the old conversation: 70%, past every nudge line.
  await measure($, w)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  // The old conversation's figure is gone, so the new one's first prompt carries no nudge.
  await ask($, 'hello, fresh start')
  expect(w.prompts[w.prompts.length - 1]?.context).toBe('')
  w.ctx = { tokens: 700000, window: 1000000, percent: 70 }
  await measure($, w)
  const band = await mountBand($)
  expect(await tree(band)).not.toMatch(/compacted twice|Compacted twice|Check running/)
  expect(await dotOf(band, 'handoff')).toBe('inactive')
  expect(await dotOf(band, 'check')).toBe('inactive')
  // Auto is a setting, not conversation state: it stays on, and its cycle is fresh.
  expect(await autoReads(band)).toBe('Auto 60%')
  await band.unmount()
  await desktopTurn($, w)
  await w.clock.advance(2000)
  expect(w.prompts.filter(p => /Auto setting/.test(p.text) && /Pre-compaction check/.test(p.text)).length).toBe(1)
})

test('one reading raises one toast per meter, and a drop re-arms it', async ($, on) => {
  const w = world(on, { tokens: 920000, window: 1000000, percent: 92 })
  await start($)
  expect(w.toasts.filter(t => /^Context at 92%$/.test(t)).length).toBe(1)
  expect(w.toasts.filter(t => /^5-hour limit at 83%$/.test(t)).length).toBe(1)
  await measure($, w)
  expect(w.toasts.filter(t => /^Context at/.test(t)).length).toBe(1)
  w.ctx = { tokens: 100000, window: 1000000, percent: 10 }
  await measure($, w)
  w.ctx = { tokens: 760000, window: 1000000, percent: 76 }
  await measure($, w)
  expect(w.toasts.filter(t => /^Context at 76%$/.test(t)).length).toBe(1)
})

test("Claude's suggestion: an amber dot and a line, once per reason; a handoff or × clears it", async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  expect(await tool($, 'suggest_new_session', { reason: 'the topic moved to the travel app.' })).toMatch(/Recorded/)
  // The line is amber with its dot, on both surfaces.
  for (const surface of SURFACES) {
    const drawn = await mountBand($, surface)
    expect([surface, await dotOf(drawn, 'handoff')]).toEqual([surface, 'warning'])
    const suggestion = /^Suggestion: a new session would serve better \(the topic moved to the travel app\)\. Press New session\.$/
    expect([surface, await lineTone(drawn, suggestion)]).toEqual([surface, 'warning'])
    await drawn.unmount()
  }
  let band = await mountBand($)
  await band.press({ key: 'dismiss' })
  await band.unmount()
  band = await mountBand($)
  expect(await dotOf(band, 'handoff')).toBe('inactive')
  await band.unmount()
  // The same reason again is not raised, even after a dismissal.
  expect(await tool($, 'suggest_new_session', { reason: 'The topic moved to the travel app' })).toMatch(/already suggested/)
  expect(w.toasts.filter(t => /Claude suggests a new session/.test(t)).length).toBe(1)
  expect(w.prompts.length).toBe(0)

  // A handoff that ends clears it for good, not just while it runs.
  await tool($, 'suggest_new_session', { reason: 'unrelated topic' })
  await press($, w, 'handoff')
  expect(await tool($, 'suggest_new_session', { reason: 'x' })).toMatch(/already running/)
  await desktopTurn($, w, () => tool($, 'not_safe_to_compact', { reason: 'an approval is waiting' }))
  band = await mountBand($)
  expect(await dotOf(band, 'handoff')).toBe('error')
  expect(await tree(band)).not.toMatch(/Suggestion:/)
  await band.unmount()
  await w.clock.advance(11 * MIN)
  band = await mountBand($)
  expect(await dotOf(band, 'handoff')).toBe('inactive')
  expect(await tree(band)).not.toMatch(/Suggestion:/)
  await band.unmount()
})

test('after two compactions the band suggests a new session by itself', async ($, on) => {
  const w = world(on, { tokens: 450000, window: 1000000, percent: 45 })
  await start($)
  for (const _ of [1, 2]) await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  await measure($, w)
  const band = await mountBand($)
  expect(await dotOf(band, 'handoff')).toBe('warning')
  // The result line carries the suggestion, so it is amber as the dot is.
  expect(await lineTone(band, /Compacted twice now: a new session would serve better\./)).toBe('warning')
  await band.unmount()
  expect(w.prompts.length).toBe(0)
})

test('both prompts stand without the skills, keep a protocol project in its format, and promote nothing', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  await press($, w, 'check')
  await ask($, 'stop')
  await press($, w, 'handoff')
  const [check, handoff] = [w.prompts.find(p => /Pre-compaction check/.test(p.text))?.text ?? '', w.prompts.find(p => /Hand this work off/.test(p.text))?.text ?? '']
  for (const p of [check, handoff]) {
    expect(p).toMatch(/complete without it/)
    expect(p).toMatch(/Installed via the `project-docs-protocol` skill/)
    expect(p).toMatch(/older than release v0\.4\.1, do not imitate its Close from memory/)
    expect(p).toMatch(/do not create one unasked/)
    expect(p).not.toMatch(/github\.com|free at|offer me project-docs-protocol|run its Install|context-budget/)
  }
  expect(handoff).toMatch(/read STATUS\.md first if it lacks the skill/)
})

test("Refresh shows the reload's own refusal, blames nothing, and says a new session loads the update", async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 }, { reloadText: "/reload-plugins isn't available over a remote connection in this session." })
  await start($)
  await press($, w, 'refresh')
  expect(w.runs.some(r => r.command === 'reload-plugins')).toBe(true)
  const band = await mountBand($)
  expect(await statusIs(band, /^Figures refreshed\. This session cannot reload the mods; a new session will\.$/)).toBeTruthy()
  const drawn = await tree(band)
  expect(drawn).not.toMatch(/Remote Control/)
  expect(drawn).toMatch(/"label":"×"/)
  await band.unmount()
  expect(w.toasts.some(t => /isn't available over a remote connection/.test(t) && /a new session loads the updated mods/.test(t))).toBe(true)
})

test('a dismissed note comes back when the same words are news again', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  await press($, w, 'refresh')
  let band = await mountBand($)
  expect(await statusIs(band, /^Figures refreshed; mods reloaded\.$/)).toBeTruthy()
  await band.press({ key: 'dismiss' })
  await band.unmount()
  await w.clock.advance(1000)
  await press($, w, 'refresh')
  band = await mountBand($)
  expect(await statusIs(band, /^Figures refreshed; mods reloaded\.$/)).toBeTruthy()
  await band.unmount()
})

test('a press while Claude works starts nothing and says so; Refresh reloads nothing and keeps the name "Claude"', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  const working = await mountBand($, 'desktop', true)
  for (const key of ['check', 'handoff']) {
    await working.press({ key })
    await w.clock.advance(250)
  }
  expect(w.prompts.length).toBe(0)
  expect(w.toasts.filter(t => /^Claude is working: press again once the turn ends\.$/.test(t)).length).toBe(2)
  await working.press({ key: 'refresh' })
  await w.clock.advance(250)
  expect(w.runs.some(r => r.command === 'reload-plugins')).toBe(false)
  expect(w.toasts.some(t => /^Figures refreshed\. The mods were not reloaded: Claude is working\.$/.test(t))).toBe(true)
  await working.unmount()
  // Once the turn has ended, the same press starts the check.
  await press($, w, 'check')
  expect(w.prompts.length).toBe(1)
})

test('the cold-cache toast comes 5 minutes before the 60-minute lifetime ends, and a new reply pushes it back', async ($, on) => {
  const w = world(on, reading.context)
  await start($)
  const cold = () => w.toasts.filter(t => /prompt cache likely goes cold/.test(t))
  await measure($, w)
  await w.clock.advance(54 * MIN)
  expect(cold().length).toBe(0)
  // A reply re-arms it: the first timer, due a minute later, must not fire.
  await measure($, w)
  await w.clock.advance(54 * MIN)
  expect(cold().length).toBe(0)
  await w.clock.advance(MIN + 1000)
  expect(cold()).toEqual(['By your 60-minute cache setting, the prompt cache likely goes cold in 5 min (~412k tokens to re-write). Reply, /compact or hand off now.'])
})

test('with a 5-minute cache the cold-cache toast comes 2 minutes before it ends', { options: { cacheTtlMinutes: 5 } }, async ($, on) => {
  const w = world(on, reading.context)
  await start($)
  const cold = () => w.toasts.filter(t => /prompt cache likely goes cold/.test(t))
  await measure($, w)
  await w.clock.advance(3 * MIN - 1000)
  expect(cold().length).toBe(0)
  await w.clock.advance(2000)
  expect(cold()).toEqual(['By your 5-minute cache setting, the prompt cache likely goes cold in 2 min (~412k tokens to re-write). Reply, /compact or hand off now.'])
})

test('Refresh during a running check re-reads the figures but does not reload', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  await press($, w, 'check')
  await press($, w, 'refresh')
  expect(w.runs.some(r => r.command === 'reload-plugins')).toBe(false)
  expect(w.toasts.some(t => /^Figures refreshed\. The mods were not reloaded: a check is already running\.$/.test(t))).toBe(true)
})

test('the band has no letter hotkeys; labels open the pane at their section; each button carries its own hover tip', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  // A measurement starts the Cache countdown, so every label draws.
  await measure($, w, ['context', 'rateLimits', 'cost'])
  const band = await mountBand($)
  const drawn = await tree(band)
  expect(drawn).not.toMatch(/"hotkey"/)
  expect(await band.find({ type: 'Text', text: /^~60m$/ })).toBeTruthy()
  // The meter names are quiet: plain and dim, as the footer's text controls.
  for (const name of ['Context', '5h', 'Week', 'Cache', 'Cost']) {
    const found = await band.find({ type: 'Button', key: `open-${name}` })
    expect(found?.text).toBe(name)
    expect(found?.props.plain).toBe(true)
    expect(found?.props.dimColor).toBe(true)
  }
  for (const id of ['check', 'handoff', 'refresh', 'auto']) {
    // Inside the control's keyed Box, after the control: a card out of the flow, hidden until the pointer is on that Box,
    // as wide as its own text so it is never squeezed to the button's width. Kept exactly as approved.
    const card = new RegExp(`"key":"tip-${id}","flexDirection":"row","alignItems":"center","columnGap":"xs"\\},"children":\\[.*?\\{"type":"Box","props":\\{"position":"absolute","top":-1,"left":0,"width":(\\d+),"display":"none"\\},"hover":\\{"display":"flex"\\},"children":\\[\\{"type":"Text","props":\\{"size":"caption","wrap":"truncate-end"\\},"children":\\[("[^"]+")\\]`).exec(drawn)
    expect(card).toBeTruthy()
    expect(Number(card?.[1])).toBe((JSON.parse(card?.[2] ?? '""') as string).length)
  }
  // Auto sits close beside Check & compact (one group, the smallest step apart), and a wider gap, not a divider, sets
  // the pair apart from New session and Refresh; that gap is a step under the 28o one (xl), which was found too far.
  const buttonRow = node((await rows(band))[1])
  expect(buttonRow.props?.columnGap).toBe('lg')
  expect(drawn).not.toContain('"columnGap":"xl"')
  const groups = (buttonRow.children ?? []).map(node)
  expect(groups.map(g => [g.props?.columnGap, ...(g.children ?? []).map(c => node(c).props?.key)])).toEqual([
    ['xs', 'tip-check', 'tip-auto'],
    ['xs', 'tip-handoff', 'tip-refresh'],
  ])
  // Auto's menu sits inside its group, in its own tip Box.
  expect(node(node(groups[0]?.children?.[1]).children?.[0]).type).toBe('Select')
  // The meters are spaced by their row's own smallest gap, each a child of that row, so a wrapped line starts with a name.
  const meters = (await rows(band))[0]
  expect(JSON.stringify(meters)).toMatch(/^\{"type":"Box","props":\{"flexDirection":"row","flexWrap":"wrap","alignItems":"center","columnGap":"xs"\}/)
  for (const name of ['Context', '5h', 'Week', 'Cache', 'Cost']) {
    expect(drawn).toMatch(new RegExp(`\\{"type":"Box","props":\\{"flexDirection":"row","alignItems":"center"\\},"children":\\[\\{"type":"Button","props":\\{"key":"open-${name}"`))
  }
  expect(drawn).not.toMatch(NOT_CLAUDE_LOOK)
  const first = async () => {
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const [ctx, lim] = [await pane.find({ type: 'Text', text: 'Context window' }), await pane.find({ type: 'Text', text: '5-hour session limit' })]
    const text = await tree(pane)
    await pane.unmount()
    if (!ctx || !lim) return undefined
    return text.indexOf('5-hour session limit') < text.indexOf('Context window') ? 'limits' : 'context'
  }
  await band.press({ key: 'open-5h' })
  expect(await first()).toBe('limits')
  await band.press({ key: 'open-Context' })
  expect(await first()).toBe('context')
  await band.press({ key: 'open-Cost' })
  expect(await first()).toBe('limits')
  await band.press({ key: 'open-Context' })
  await band.press({ key: 'open-Cache' })
  expect(await first()).toBe('limits')
  // A surface that refuses the pane does not break the press.
  w.openFails = true
  await band.press({ key: 'open-Week' })
  await band.unmount()
})

test('the terminal band draws block bars and the ✻ mark while a check runs, with no SVG', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  await press($, w, 'check')
  const band = await mountBand($, 'terminal')
  expect(await band.find({ type: 'Text', text: /█/ })).toBeTruthy()
  // The terminal has no tooltip box, so its tip card is inverse text; the desktop's box needs none.
  expect((await band.find({ type: 'Text', text: / Claude checks it is safe, then compacts /}))?.props.inverse).toBe(true)
  expect(await band.find({ type: 'Text', text: '✻' })).toBeTruthy()
  expect(await band.find({ type: 'Svg' })).toBeFalsy()
  await band.unmount()
  for (const surface of ['vscode', 'mobile'] as const) {
    const other = await mountBand($, surface)
    expect(await other.find({ type: 'Text', text: /^64%$/ })).toBeTruthy()
    await other.unmount()
  }
})

test('after a compaction the band and pane show the smaller context at once, marked estimated, until measured', async ($, on) => {
  const w = world(on, { tokens: 462000, window: 1000000, percent: 46 }, { tokensAfter: 38000 })
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  let band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /^~4%$/ })).toBeTruthy()
  expect(await statusIs(band, /^Compacted\. Context now ~4%\.$/)).toBeTruthy()
  for (const l of [/Check & compact$/, /New session$/, /^Refresh$/]) expect(await label(band, l)).toBeTruthy()
  expect(await autoReads(band)).toBe('Auto Off')
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^~38k of 1M tokens/ })).toBeTruthy()
  await pane.unmount()
  // A limits-only measurement keeps the estimate; the next context measurement replaces it.
  await measure($, w, ['rateLimits'])
  band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /^~4%$/ })).toBeTruthy()
  await band.unmount()
  w.ctx = { tokens: 61000, window: 1000000, percent: 6.1 }
  await measure($, w)
  band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /^6%$/ })).toBeTruthy()
  await band.unmount()
})

test('a stale breakdown right after a compaction falls back to the compaction count', async ($, on) => {
  const stale = {
    categories: [{ name: 'Messages', tokens: 620000, color: 'promptBorder', isDeferred: false, kind: 'used' }],
    totalTokens: 620000, maxTokens: 1000000, rawMaxTokens: 1000000, percentage: 62, gridRows: [], model: 'opus',
    memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
  }
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 }, { breakdown: stale })
  await start($)
  await measure($, w)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /^~4%$/ })).toBeTruthy()
  await band.unmount()
})

test('a small compaction keeps the unchanged overhead in its figure; the pane lists the breakdown', async ($, on) => {
  const fresh = {
    categories: [
      { name: 'System tools', tokens: 35000, color: 'inactive', isDeferred: false, kind: 'used' },
      { name: 'Messages', tokens: 15000, color: 'promptBorder', isDeferred: false, kind: 'used' },
      { name: 'MCP tools', tokens: 291300, color: 'inactive', isDeferred: true, kind: 'deferred' },
    ],
    totalTokens: 50000, maxTokens: 1000000, rawMaxTokens: 1000000, percentage: 5, gridRows: [], model: 'opus',
    memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 967000, apiUsage: null,
  }
  const w = world(on, { tokens: 50000, window: 1000000, percent: 5 }, { breakdown: fresh, tokensAfter: 5000 })
  await start($)
  await measure($, w)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 35k of overhead plus 5k of kept messages, not the 5k alone.
  expect(await pane.find({ type: 'Text', text: /^~40k of 1M tokens/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: 'Messages' })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: 'MCP tools (deferred)' })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /Auto-compact at 967k/ })).toBeTruthy()
  await pane.unmount()
})

test('a printed brief reads right, and an empty suggestion reason still shows', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  await tool($, 'suggest_new_session', { reason: ' . ' })
  let band = await mountBand($)
  expect(await statusIs(band, /\(Claude suggests it\)/)).toBeTruthy()
  await band.unmount()
  await press($, w, 'handoff')
  let said = ''
  await desktopTurn($, w, async () => (said = await tool($, 'ready_to_hand_off', { state_page: '/p', new_session: 'brief printed' })))
  expect(said).toMatch(/paste the printed brief into a new session/)
  expect(said).not.toMatch(/click the card/)
  band = await mountBand($)
  expect(await statusIs(band, /^New session ready: start a new session and paste the printed brief\.$/)).toBeTruthy()
  await band.unmount()
})

// Drives the not-safe, suggestion and refresh paths, which are the ones that used to record free text.
async function leaveBreadcrumbs($: Engine, on: On): Promise<World> {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 }, { reloadText: 'x'.repeat(400) })
  await start($)
  await press($, w, 'check')
  await tool($, 'not_safe_to_compact', { reason: 'secret reason about the payroll repo' })
  await tool($, 'suggest_new_session', { reason: 'secret hint about the payroll repo' })
  await press($, w, 'refresh')
  return w
}

test('diagnostics off writes no breadcrumb file', async ($, on) => {
  const w = await leaveBreadcrumbs($, on)
  expect(w.writes.length).toBe(0)
})

test('diagnostics on records that things happened, not what Claude wrote', { options: { diagnostics: true } }, async ($, on) => {
  const w = await leaveBreadcrumbs($, on)
  const last = w.writes[w.writes.length - 1]
  expect(last?.path).toBe('/tmp/claude-mods-diag/context-pit-crew-s1.json')
  const crumbs = JSON.parse(last?.text ?? '{}') as Record<string, unknown>
  expect(crumbs.notSafe).toBe(true)
  expect(crumbs.hint).toBe(true)
  expect(typeof crumbs.notSafeAt).toBe('number')
  expect(String(crumbs.refreshResult).length).toBe(200)
  expect(last?.text ?? '').not.toMatch(/payroll/)
})

test('diagnostics on also records the origin kind and the command of each prompt, never its text', { options: { diagnostics: true } }, async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  const crumbs = () => JSON.parse(w.writes[w.writes.length - 1]?.text ?? '{}') as Record<string, unknown>
  await ask($, 'a private question')
  expect(crumbs().promptOrigin).toBe('composer')
  expect(crumbs().promptCommand).toBeNull()
  await typed($, 'pit-crew', 'check')
  expect(crumbs().promptOrigin).toBe('composer')
  expect(crumbs().promptCommand).toBe('pit-crew')
  await $.prompt.submit({ text: 'a private notice', wait: false, origin: { kind: 'task-notification' } })
  expect(crumbs().promptOrigin).toBe('task-notification')
  expect(crumbs().promptCommand).toBeNull()
  expect(typeof crumbs().promptAt).toBe('number')
  expect(w.writes.map(x => x.text).join('')).not.toMatch(/private/)
})

test('an option moves a context line through the nudge and the Auto text', { options: { contextCompact: 70, contextOverdue: 85 } }, async ($, on) => {
  const w = world(on, { tokens: 650000, window: 1000000, percent: 65 })
  await start($)
  await measure($, w)
  // 65% is under the moved compact line, so only the state-page nudge is due.
  await ask($, 'one')
  expect(w.prompts[0]?.context).toMatch(/Context is at 65%\. Do what the user asks first\. If this session keeps a start-here state page/)
  expect(w.prompts[0]?.context).not.toMatch(/good time to press/)
  const auto = await run($, 'auto on')
  expect(JSON.stringify(auto)).toMatch(/past 70% context/)
  // The context meter's tone follows the moved lines, not the default 60% and 75%: normal under 70%, amber from it, red from 85%.
  const steps: [number, string | undefined][] = [[65, undefined], [70, 'warning'], [84, 'warning'], [85, 'error']]
  for (const [percent, t] of steps) {
    w.ctx = { tokens: percent * 10000, window: 1000000, percent }
    await measure($, w)
    for (const surface of SURFACES) {
      const band = await mountBand($, surface)
      expect([surface, percent, (await band.find({ type: 'Text', text: new RegExp(`^${percent}%$`) }))?.props.color]).toEqual([surface, percent, t])
      await band.unmount()
    }
  }
})

test('out-of-order lines fall back to the defaults together', { options: { contextWatch: 80, contextStatePage: 50 } }, async ($, on) => {
  const w = world(on, { tokens: 450000, window: 1000000, percent: 45 })
  await start($)
  await measure($, w)
  const band = await mountBand($)
  expect(await statusIs(band, /^Watch for the next good spot\.$/)).toBeTruthy()
  await band.unmount()
})

test('a saved Auto setting and level are restored at session start', async ($, on) => {
  world(on, { tokens: 300000, window: 1000000, percent: 30 }, { stored: { autoCheck: true, autoAt: 75 } })
  await start($)
  const band = await mountBand($)
  expect(await autoReads(band)).toBe('Auto 75%')
  await band.unmount()
})

test('/pit-crew auto N sets the level Auto runs at, and Auto waits for it', async ($, on) => {
  const w = world(on, { tokens: 700000, window: 1000000, percent: 70 })
  await start($)
  // Anything after "auto" that is not on, off or a whole level is refused, never answered with the pane.
  for (const bad of ['auto 0', 'auto 100', 'auto 150%', 'auto 1000', 'auto 1.5', 'auto -5', 'auto 70 80', 'auto high']) {
    expect(JSON.stringify(await run($, bad))).toMatch(/from 1 to 99/)
  }
  expect(w.stored.autoCheck).toBeUndefined()
  expect(w.opens).toBe(0)
  expect(JSON.stringify(await run($, 'auto 80%'))).toMatch(/on: it runs once when a turn ends past 80% context/)
  expect(w.stored.autoAt).toBe(80)
  await measure($, w)
  // 70% is under 80%: a finished turn starts nothing.
  await desktopTurn($, w)
  await w.clock.advance(2000)
  expect(w.prompts.length).toBe(0)
  await run($, 'auto 65')
  await desktopTurn($, w)
  await w.clock.advance(2000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]?.text).toMatch(/because context passed 65%/)
  const help = await run($, 'help')
  expect(JSON.stringify(help)).toMatch(/past 65% context/)
  expect(JSON.stringify(await run($, 'auto off'))).toMatch(/check off/)
  expect(w.stored.autoAt).toBe(65)
})

test('a plan without limits says so once a reply has come; help lists the four buttons and what Auto spends', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 }, { noLimits: true })
  await start($)
  let pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'No reading yet' })).toBeTruthy()
  await pane.unmount()
  await w.clock.advance(10 * 1000)
  await $.session.measure({ context: w.ctx, rateLimits: [], changed: ['context'] })
  pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'Not on this plan' })).toBeTruthy()
  await pane.unmount()

  const help = JSON.stringify(await run($, 'help'))
  for (const name of ['Check & compact', 'New session', 'Refresh', 'Auto']) expect(help).toContain(name)
  expect(help).toMatch(/After two compactions it runs the New session handoff instead/)
})

for (const [name, options, opens, fails] of [
  ['stays closed at session start by default', {}, 0, false],
  ['opens at session start with openPaneOnStart, and a refused open does not stop the session', { openPaneOnStart: true }, 1, true],
] as const) {
  test(`the Usage pane ${name}`, { options }, async ($, on) => {
    const w = world(on, reading.context, { openFails: fails })
    await start($)
    await w.clock.settle()
    expect(w.opens).toBe(opens)
    // The session went on: the reading was recorded.
    const band = await mountBand($)
    expect(await band.find({ type: 'Text', text: /^41%$/ })).toBeTruthy()
    await band.unmount()
  })
}

// Claude Code's own design language: quiet plain controls, one text size per row, a dim name beside a value in normal
// text, the app's blue for a normal meter (amber past the warning line, red past the limit), Claude's orange only while
// Claude works, and spacing instead of dividers.
const BREAKDOWN = {
  categories: [
    { name: 'System tools', tokens: 35000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 15000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 600000, color: 'subtle', isDeferred: false, kind: 'free' },
    { name: 'MCP tools', tokens: 291300, color: 'inactive', isDeferred: true, kind: 'deferred' },
  ],
  totalTokens: 50000, maxTokens: 1000000, rawMaxTokens: 1000000, percentage: 5, gridRows: [], model: 'opus',
  memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 967000, apiUsage: null,
}
const SURFACES = ['desktop', 'terminal'] as const

test('the look: every band control is plain, all the band\'s text is caption size, and no emoji or divider is drawn in band or pane', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 }, { breakdown: BREAKDOWN })
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  const check = async (state: string) => {
    for (const surface of SURFACES) {
      const band = await mountBand($, surface)
      const buttons = await band.findAll({ type: 'Button' })
      // Five meter names, three buttons, and the status line's × whenever the line is drawn; Auto is a menu.
      expect(buttons.length).toBeGreaterThanOrEqual(8)
      for (const b of buttons) expect(`${state} ${surface} ${b.key}: ${String(b.props.plain)}`).toBe(`${state} ${surface} ${b.key}: true`)
      expect((await band.findAll({ type: 'Select' })).map(s => s.key)).toEqual(['auto'])
      // Every Text in every row (the figures, the dots, the status line) is caption size, as before 28o; a row drawn
      // all in SVG (the running line on the desktop) has no Text. Only the Buttons' labels are drawn larger, by the surface.
      for (const row of await rows(band)) expect([...sizesIn(row)].filter(size => size !== 'caption')).toEqual([])
      expect([...sizesIn(JSON.parse(await tree(band)))]).toEqual(['caption'])
      expect(await tree(band)).not.toMatch(NOT_CLAUDE_LOOK)
      await band.unmount()
    }
  }
  await check('idle')
  await press($, w, 'check')
  await check('running')
  await tool($, 'not_safe_to_compact', { reason: 'mid-edit' })
  await check('refused')
  expect(await tool($, 'suggest_new_session', { reason: 'the topic moved on' })).toMatch(/Recorded/)
  await check('suggested')

  // The pane: one (body) size throughout (only the band went back to caption), each section titled in semibold, names
  // and details dim, values in normal text.
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const drawn = await tree(pane)
    expect(drawn).not.toMatch(NOT_CLAUDE_LOOK)
    expect([...sizesIn(JSON.parse(drawn))]).toEqual(['body'])
    for (const title of ['Context window', '5-hour session limit', 'Weekly limit', 'Prompt cache', 'Session cost (API-equivalent)']) {
      expect((await pane.find({ type: 'Text', text: title }))?.props.weight).toBe('semibold')
    }
    expect((await pane.find({ type: 'Text', text: /^640k of 1M tokens/ }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^resets in / }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: 'Messages' }))?.props.dimColor).toBe(true)
    // A used category's token count is the value, in normal text; a free one is dim throughout.
    expect((await pane.find({ type: 'Text', text: '15k' }))?.props.dimColor).toBe(false)
    expect((await pane.find({ type: 'Text', text: '600k' }))?.props.dimColor).toBe(true)
    expect((await pane.find({ type: 'Text', text: /^\$12\.35$/ }))?.props.color).toBeUndefined()
    await pane.unmount()
  }
})

test('the state dot: one before each check button, always drawn, coloured by state on both surfaces', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await measure($, w)
  const dots = async (want: [string, string]) => {
    for (const surface of SURFACES) {
      const band = await mountBand($, surface)
      expect([surface, await dotOf(band, 'check'), await dotOf(band, 'handoff')]).toEqual([surface, ...want])
      // The words never change with the state, so no button moves.
      expect(await label(band, /^Check & compact$/)).toBeTruthy()
      expect(await label(band, /^New session$/)).toBeTruthy()
      await band.unmount()
    }
  }
  await dots(['inactive', 'inactive'])
  await press($, w, 'check')
  await dots(['claude', 'inactive'])
  await tool($, 'not_safe_to_compact', { reason: 'mid-edit' })
  await dots(['error', 'inactive'])
  await w.clock.advance(11 * MIN)
  await dots(['inactive', 'inactive'])
  await tool($, 'suggest_new_session', { reason: 'the topic moved on' })
  await dots(['inactive', 'warning'])
  await press($, w, 'check')
  await desktopTurn($, w, async () => {
    await tool($, 'ready_to_compact', READY)
    await measure($, w)
  })
  // Confirmed: green while the compaction waits for the session to be idle. The suggestion stands until a compaction.
  await dots(['success', 'warning'])
  await w.clock.advance(2000)
  expect(w.compacts.length).toBe(1)
  await dots(['inactive', 'inactive'])
  await press($, w, 'handoff')
  await dots(['inactive', 'claude'])
  await desktopTurn($, w, () => tool($, 'ready_to_hand_off', { state_page: '/p', new_session: 'Continue: x' }))
  await dots(['inactive', 'success'])
  await press($, w, 'refresh')
  // Auto and Refresh carry no state, so they have no dot.
  const band = await mountBand($)
  // Three dots in all: the two check buttons' and the Cache meter's (a string query also finds the Text holding it).
  expect((await band.findAll({ type: 'Text', text: /^●$/ })).length).toBe(3)
  await band.unmount()
})

// Auto's menu as the default settings list it: Off, then the four levels in order.
const AUTO_MENU = [
  { value: 'off', label: 'Off' },
  { value: '50', label: '50%' },
  { value: '60', label: '60%' },
  { value: '70', label: '70%' },
  { value: '80', label: '80%' },
]
const autoNote = (level: string) => (level === 'off' ? /^Auto Off\.$/ : new RegExp(`^Auto ${level}%\\. The check runs once a turn ends past ${level}% context\\.$`))

test('Auto is a menu on both surfaces, as the effort menu is: Off and the levels, the current one picked; a pick is saved and its note spells it the same', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  // Picks in an order the old press-to-step cycle could not make: a menu goes straight to any option.
  for (const surface of SURFACES) {
    for (const pick of ['70', '50', '80', 'off', '60', 'off']) {
      const band = await mountMenuBand($, surface)
      const menu = await band.find({ type: 'Select', key: 'auto' })
      expect([surface, menu?.props.label, menu?.props.options]).toEqual([surface, 'Auto', AUTO_MENU])
      // No Auto Button and no separate level Text: the menu shows its own value.
      expect(await band.find({ type: 'Button', key: 'auto' })).toBeUndefined()
      const beside = (await band.find({ type: 'Box', key: 'tip-auto' }))?.children.filter(c => node(c).type === 'Text')
      expect([surface, beside]).toEqual([surface, []])
      // The pick runs the Select's own onSelect, as a person picking it does.
      await band.select({ key: 'auto', value: pick })
      await band.unmount()
      expect([surface, pick, w.stored.autoCheck]).toEqual([surface, pick, pick !== 'off'])
      if (pick !== 'off') expect([surface, w.stored.autoAt]).toEqual([surface, Number(pick)])
      const after = await mountBand($, surface)
      expect([surface, (await after.find({ type: 'Select', key: 'auto' }))?.props.value]).toEqual([surface, pick])
      expect([surface, await autoReads(after)]).toEqual([surface, pick === 'off' ? 'Auto Off' : `Auto ${pick}%`])
      expect([surface, (await after.find({ type: 'Text', text: autoNote(pick) }))?.props.color]).toEqual([surface, 'suggestion'])
      expect(await tree(after)).not.toMatch(/Auto:/)
      await after.unmount()
    }
  }
  // Off keeps the last level saved, so turning Auto on again from the command starts there.
  expect(w.stored.autoAt).toBe(60)
  expect(JSON.stringify(await run($, 'auto on'))).toMatch(/past 60% context/)
  // Help says to pick from the menu, and no longer that each press steps it.
  const help = JSON.stringify(await run($, 'help'))
  expect(help).toMatch(/Pick Off or a level from its menu \(50, 60, 70, 80%\); \/pit-crew auto N sets any level\./)
  expect(help).not.toMatch(/Each press steps/)
})

test('a level set by /pit-crew auto N is listed in its place in the menu, picked; another pick drops it', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  const menuOf = async (surface: (typeof SURFACES)[number]) => {
    const band = await mountBand($, surface)
    const menu = await band.find({ type: 'Select', key: 'auto' })
    await band.unmount()
    return [menu?.props.value, optionsOf(menu).map(o => o.value).join(' ')]
  }
  await run($, 'auto 65')
  for (const surface of SURFACES) expect([surface, ...(await menuOf(surface))]).toEqual([surface, '65', 'off 50 60 65 70 80'])
  await run($, 'auto 95%')
  for (const surface of SURFACES) expect([surface, ...(await menuOf(surface))]).toEqual([surface, '95', 'off 50 60 70 80 95'])
  // Turned off, the saved level stays listed, so the current setting is always one of the options.
  await run($, 'auto off')
  for (const surface of SURFACES) expect([surface, ...(await menuOf(surface))]).toEqual([surface, 'off', 'off 50 60 70 80 95'])
  await pickFromAuto($, '95', 'terminal')
  expect([w.stored.autoCheck, w.stored.autoAt]).toEqual([true, 95])
  for (const surface of SURFACES) expect([surface, ...(await menuOf(surface))]).toEqual([surface, '95', 'off 50 60 70 80 95'])
  await pickFromAuto($, '70')
  for (const surface of SURFACES) expect([surface, ...(await menuOf(surface))]).toEqual([surface, '70', 'off 50 60 70 80'])
  // A level the command set is the one Auto runs at, and the menu agrees with the command's answer.
  expect(JSON.stringify(await run($, 'auto 1'))).toMatch(/past 1% context/)
  for (const surface of SURFACES) expect([surface, ...(await menuOf(surface))]).toEqual([surface, '1', 'off 1 50 60 70 80'])
})

test('with contextCompact moved off the menu, Auto lists that level until another is picked', { options: { contextCompact: 65, contextOverdue: 85 } }, async ($, on) => {
  world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    const menu = await band.find({ type: 'Select', key: 'auto' })
    expect([surface, menu?.props.value, optionsOf(menu).map(o => o.label).join(' ')]).toEqual([surface, 'off', 'Off 50% 60% 65% 70% 80%'])
    await band.unmount()
  }
})

test('the mobile app draws no menu: there Auto is a plain button that steps through the same options, its level dim beside it', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  const steps: [string, string][] = [['Off', '50'], ['50%', '60'], ['60%', '70'], ['70%', '80'], ['80%', 'off'], ['Off', '50']]
  for (const [shown, next] of steps) {
    const band = await mountBand($, 'mobile')
    expect(await band.find({ type: 'Select' })).toBeUndefined()
    const auto = await band.find({ type: 'Button', key: 'auto' })
    expect([auto?.props.label, auto?.props.plain]).toEqual(['Auto', true])
    expect(await autoReads(band)).toBe(`Auto ${shown}`)
    expect((await band.find({ type: 'Text', text: new RegExp(`^${shown}$`) }))?.props).toEqual({ size: 'caption', dimColor: true })
    await band.press({ key: 'auto' })
    await band.unmount()
    expect([shown, w.stored.autoCheck]).toEqual([shown, next !== 'off'])
    const noted = await mountBand($, 'mobile')
    expect(await noted.find({ type: 'Text', text: autoNote(next) })).toBeTruthy()
    await noted.unmount()
  }
  // A level the command set steps on to the next one listed.
  await run($, 'auto 65')
  const band = await mountBand($, 'mobile')
  expect(await autoReads(band)).toBe('Auto 65%')
  await band.press({ key: 'auto' })
  await band.unmount()
  expect(w.stored.autoAt).toBe(70)
})

test('inside a meter the parts sit one space apart, not a gap step; the meters the smallest step apart; the terminal row is no wider than before', async ($, on) => {
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 })
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    const row = node((await rows(band))[0])
    expect([surface, row.props?.columnGap]).toEqual([surface, 'xs'])
    const meters = (row.children ?? []).map(node)
    expect(meters.map(m => node(m.children?.[0]).props?.key)).toEqual(['open-Context', 'open-5h', 'open-Week', 'open-Cache', 'open-Cost'])
    for (const meter of meters) {
      // No gap step inside a meter: only its direction and alignment.
      expect([surface, meter.props]).toEqual([surface, { flexDirection: 'row', alignItems: 'center' }])
      // And every Text in it caption size, the figures included.
      expect([surface, [...sizesIn(meter)]]).toEqual([surface, ['caption']])
    }
    // Each figure a caption space after the part before it; the name's own padding stands in for that space on the desktop.
    const context = meters[0]
    if (surface === 'desktop') {
      expect(context.children?.map(c => node(c).type)).toEqual(['Button', 'Svg', 'Text'])
      expect(node(context.children?.[1]).props?.width).toBe(32)
      expect(textOf(context.children?.[2])).toBe(' 64% 640k')
      expect(textOf(meters[3])).toBe('Cache● ~60m')
      expect(textOf(meters[4])).toBe('Cost$12.35')
    } else {
      // The terminal: the block bars, each part one cell apart and each meter one cell from the next. 28o drew the same
      // parts one cell apart (its xs step) but the meters three cells apart (lg): 110 cells, so this line is 8 narrower.
      const line = await terminalMeterLine(band)
      expect(line).toBe('Context ██████░░░░ 64% 640k 5h ████████░░ 83% 2h 0m Week ███░░░░░░░ 31% 2h 0m Cache ● ~60m Cost $12.35')
      expect(line.length).toBe(102)
    }
    await band.unmount()
  }
  // VS Code and the mobile app draw the SVG bar too, but their Button padding has not been measured: there a caption
  // space follows each name, so no name runs into its bar, its dot or its figure.
  for (const surface of ['vscode', 'mobile'] as const) {
    const band = await mountBand($, surface)
    const row = node((await rows(band))[0])
    const meters = (row.children ?? []).map(node)
    for (const meter of meters) {
      expect([surface, meter.props]).toEqual([surface, { flexDirection: 'row', alignItems: 'center' }])
      expect([surface, [...sizesIn(meter)]]).toEqual([surface, ['caption']])
    }
    const context = meters[0]
    expect([surface, context.children?.map(c => node(c).type)]).toEqual([surface, ['Button', 'Text', 'Svg', 'Text']])
    expect([surface, textOf(context.children?.[1])]).toEqual([surface, ' '])
    expect([surface, textOf(meters[0])]).toEqual([surface, 'Context  64% 640k'])
    expect([surface, textOf(meters[3])]).toEqual([surface, 'Cache ● ~60m'])
    expect([surface, textOf(meters[4])]).toEqual([surface, 'Cost $12.35'])
    await band.unmount()
  }
})

test('a reading that leaves out a limit keeps its meter, with its own figures, until that limit resets; then it goes', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  const toasts = w.toasts.length
  const limits = (rateLimits: { kind: string; percentUsed: number; resetsAt: string }[]) =>
    $.session.measure({ ...reading, context: w.ctx, rateLimits, changed: ['context', 'rateLimits'] })
  const shown = async (surface: (typeof SURFACES)[number]) => {
    const band = await mountBand($, surface)
    const drawn = await tree(band)
    await band.unmount()
    // Each meter's name and the figures after it, as the row draws them.
    return ['5h', 'Week'].map(name => new RegExp(`"key":"open-${name}".*?"children":\\[" ",\\{"type":"Text"[^\\]]*\\["([^"]+)"\\]\\}," ",\\{"type":"Text","props":\\{"dimColor":true\\},"children":\\["([^"]+)"`).exec(drawn)?.slice(1).join(' ') ?? 'gone')
  }
  for (const surface of SURFACES) expect([surface, ...(await shown(surface))]).toEqual([surface, '83% 2h 0m', '31% 2h 0m'])
  // Half an hour on (22:30), a reading with the weekly window alone: 5h stays with its own figure and reset time, so its
  // countdown still runs from that reset, nothing about it reads as newly measured, and it raises no toast again.
  await w.clock.advance(30 * MIN)
  await limits([{ kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-01T03:00:00Z' }])
  for (const surface of SURFACES) expect([surface, ...(await shown(surface))]).toEqual([surface, '83% 1h 30m', '33% 4h 30m'])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^82\.5%$/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /^resets in 1h 30m/ })).toBeTruthy()
  await pane.unmount()
  expect(w.toasts.slice(toasts).filter(t => /limit at/.test(t))).toEqual([])
  // A reading with neither window keeps both.
  await limits([])
  for (const surface of SURFACES) expect([surface, ...(await shown(surface))]).toEqual([surface, '83% 1h 30m', '33% 4h 30m'])
  // A reading that has the window again replaces the kept one.
  await limits([{ kind: 'five_hour', percentUsed: 40, resetsAt: '2099-01-01T05:00:00Z' }])
  for (const surface of SURFACES) expect([surface, ...(await shown(surface))]).toEqual([surface, '40% 6h 30m', '33% 4h 30m'])
  // Past its reset time (03:00) with no reading of it, a window goes; one still open stays.
  await w.clock.advance(4 * 60 * MIN + 31 * MIN)
  await limits([])
  for (const surface of SURFACES) expect([surface, ...(await shown(surface))]).toEqual([surface, '40% 1h 59m', 'gone'])
  await w.clock.advance(2 * 60 * MIN)
  await limits([])
  for (const surface of SURFACES) expect([surface, ...(await shown(surface))]).toEqual([surface, 'gone', 'gone'])
  // A plan with no limits shows none: nothing is kept that was never read.
  const band = await mountBand($)
  expect(await band.find({ type: 'Button', key: 'open-5h' })).toBeUndefined()
  expect(await band.find({ type: 'Button', key: 'open-Week' })).toBeUndefined()
  await band.unmount()
})

test('a carried limit is not drawn past its reset time even when no reading comes after it; a limit just read still reads "resetting"', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  // 22:00: both windows read, each resetting at 00:00.
  await measure($, w, ['context', 'rateLimits', 'cost'])
  const limits = (rateLimits: { kind: string; percentUsed: number; resetsAt: string }[]) =>
    $.session.measure({ ...reading, context: w.ctx, rateLimits, changed: ['context', 'rateLimits'] })
  // 22:30: a reading with the weekly window alone (now resetting at 03:00), so 5h is carried. Then no reading at all.
  await w.clock.advance(30 * MIN)
  await limits([{ kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-01T03:00:00Z' }])
  const ALL = [...SURFACES, 'vscode', 'mobile'] as const
  // 23:59: a minute before its reset, the carried 5h is still drawn, with its own figure and countdown.
  await w.clock.advance(89 * MIN)
  for (const surface of ALL) {
    const band = await mountBand($, surface)
    expect([surface, Boolean(await band.find({ type: 'Button', key: 'open-5h' }))]).toEqual([surface, true])
    expect([surface, Boolean(await band.find({ type: 'Text', text: /^1m$/ }))]).toEqual([surface, true])
    await band.unmount()
  }
  // 00:01, still no reading: past its reset the carried 5h is drawn nowhere, neither as a figure nor as "resetting".
  // The weekly window, still open, stays.
  await w.clock.advance(2 * MIN)
  for (const surface of ALL) {
    const band = await mountBand($, surface)
    expect([surface, await band.find({ type: 'Button', key: 'open-5h' })]).toEqual([surface, undefined])
    expect([surface, Boolean(await band.find({ type: 'Button', key: 'open-Week' }))]).toEqual([surface, true])
    expect(await tree(band)).not.toMatch(/resetting|83%/)
    await band.unmount()
    const pane = await $.ui.mount({ ...PANE, surface })
    expect([surface, await pane.find({ type: 'Text', text: /^82\.5%$/ })]).toEqual([surface, undefined])
    expect([surface, Boolean(await pane.find({ type: 'Text', text: /^33%$/ }))]).toEqual([surface, true])
    expect(await tree(pane)).not.toMatch(/resetting/)
    await pane.unmount()
  }
  // A window the latest reading has is drawn as read, as before carry-over: past its reset time it reads "resetting"
  // until the next reading.
  await limits([
    { kind: 'five_hour', percentUsed: 40, resetsAt: '2099-01-01T00:30:00Z' },
    { kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-01T03:00:00Z' },
  ])
  await w.clock.advance(45 * MIN)
  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    expect([surface, Boolean(await band.find({ type: 'Button', key: 'open-5h' }))]).toEqual([surface, true])
    expect([surface, Boolean(await band.find({ type: 'Text', text: /^resetting$/ }))]).toEqual([surface, true])
    await band.unmount()
  }
  // The next reading without it carries nothing past its reset: the window goes.
  await limits([{ kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-01T03:00:00Z' }])
  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    expect([surface, await band.find({ type: 'Button', key: 'open-5h' })]).toEqual([surface, undefined])
    await band.unmount()
  }
})

test('a fractional contextCompact level is listed in the menu and picking it works, as every option shown must', { options: { contextCompact: 62.5 } }, async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  for (const surface of SURFACES) {
    const band = await mountMenuBand($, surface)
    const menu = await band.find({ type: 'Select', key: 'auto' })
    expect([surface, menu?.props.value, optionsOf(menu).map(o => o.label).join(' ')]).toEqual([surface, 'off', 'Off 50% 60% 62.5% 70% 80%'])
    await band.unmount()
  }
  for (const surface of SURFACES) {
    await pickFromAuto($, 'off', surface)
    expect([surface, w.stored.autoCheck]).toEqual([surface, false])
    await pickFromAuto($, '62.5', surface)
    expect([surface, w.stored.autoCheck, w.stored.autoAt]).toEqual([surface, true, 62.5])
    const band = await mountBand($, surface)
    expect([surface, (await band.find({ type: 'Select', key: 'auto' }))?.props.value]).toEqual([surface, '62.5'])
    expect([surface, await autoReads(band)]).toEqual([surface, 'Auto 62.5%'])
    expect([surface, Boolean(await band.find({ type: 'Text', text: /^Auto 62\.5%\. The check runs once a turn ends past 62\.5% context\.$/ }))]).toEqual([surface, true])
    await band.unmount()
  }
})

test('a saved fractional Auto level is restored at session start', async ($, on) => {
  world(on, { tokens: 300000, window: 1000000, percent: 30 }, { stored: { autoCheck: true, autoAt: 62.5 } })
  await start($)
  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    expect([surface, await autoReads(band)]).toEqual([surface, 'Auto 62.5%'])
    await band.unmount()
  }
})

test('diagnostics on records which limit windows each reading reports, so a live run shows whether five_hour comes', { options: { diagnostics: true } }, async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  const crumbs = (): Record<string, unknown> => JSON.parse(w.writes[w.writes.length - 1]?.text ?? '{}')
  await measure($, w, ['context', 'rateLimits'])
  expect(crumbs().limitKinds).toBe('five_hour,seven_day')
  await $.session.measure({ ...reading, context: w.ctx, rateLimits: [{ kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-01T03:00:00Z' }], changed: ['rateLimits'] })
  expect(crumbs().limitKinds).toBe('seven_day')
  await $.session.measure({ ...reading, context: w.ctx, rateLimits: [], changed: ['context'] })
  expect(crumbs().limitKinds).toBe('')
})

test('tones: a meter is blue while normal, amber past its warning line, red past its limit; its value takes the tone only then', async ($, on) => {
  const w = world(on, { tokens: 300000, window: 1000000, percent: 30 })
  await start($)
  const limits = (five: number, week: number) =>
    $.session.measure({
      ...reading,
      context: w.ctx,
      rateLimits: [
        { kind: 'five_hour', percentUsed: five, resetsAt: '2099-01-01T00:00:00Z' },
        { kind: 'seven_day', percentUsed: week, resetsAt: '2099-01-01T00:00:00Z' },
      ],
      changed: ['context', 'rateLimits', 'cost'],
    })
  // Each meter's tone, read from its bar and its value (by the value's own text) on both surfaces.
  const tones = async (want: [name: string, shown: string, t: string][]) => {
    for (const surface of SURFACES) {
      const band = await mountBand($, surface)
      const drawn = await tree(band)
      for (const [name, shown, t] of want) {
        // The value: no colour while the meter is normal, the tone once it warns.
        const value = await band.find({ type: 'Text', text: new RegExp(`^${shown}$`) })
        expect([surface, name, value ? value.props.color ?? 'normal' : 'missing']).toEqual([surface, name, t === 'suggestion' ? 'normal' : t])
        if (surface === 'desktop') {
          const bar = (await band.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith(`${name} `))
          expect([name, String(bar?.props.source).includes(`fill="${HEX[t]}"`)]).toEqual([name, true])
          // The track stays a subtle grey.
          expect(String(bar?.props.source)).toContain('fill="#8a8a8a" fill-opacity="0.28"')
        } else {
          expect(drawn).toMatch(new RegExp(`"key":"open-${name}".*?\\{"type":"Text","props":\\{"size":"caption"\\},"children":\\[" ",\\{"type":"Text","props":\\{"color":"${t}"\\},"children":\\["█*"\\]\\},\\{"type":"Text","props":\\{"color":"subtle"\\}`))
        }
      }
      await band.unmount()
    }
  }
  // Context past the watch and state-page lines but under the compact line is still normal.
  w.ctx = { tokens: 590000, window: 1000000, percent: 59 }
  await limits(31, 74)
  await tones([['Context', '59%', 'suggestion'], ['5h', '31%', 'suggestion'], ['Week', '74%', 'suggestion']])
  // Context's warning line is the compact line (60%), its limit the overdue line (75%); a limit warns at 75% and 90%.
  w.ctx = { tokens: 640000, window: 1000000, percent: 64 }
  await limits(82.5, 30)
  await tones([['Context', '64%', 'warning'], ['5h', '83%', 'warning'], ['Week', '30%', 'suggestion']])
  w.ctx = { tokens: 800000, window: 1000000, percent: 80 }
  await limits(91, 95)
  await tones([['Context', '80%', 'error'], ['5h', '91%', 'error'], ['Week', '95%', 'error']])
  // Each line exactly, so a moved threshold fails: a limit is amber from 75% and red from 90%; context is amber from
  // the compact line and red from the overdue line (60% and 75% by default).
  w.ctx = { tokens: 600000, window: 1000000, percent: 60 }
  await limits(75, 90)
  await tones([['Context', '60%', 'warning'], ['5h', '75%', 'warning'], ['Week', '90%', 'error']])
  w.ctx = { tokens: 740000, window: 1000000, percent: 74 }
  await limits(89, 75)
  await tones([['Context', '74%', 'warning'], ['5h', '89%', 'warning'], ['Week', '75%', 'warning']])
  w.ctx = { tokens: 750000, window: 1000000, percent: 75 }
  await limits(90, 89)
  await tones([['Context', '75%', 'error'], ['5h', '90%', 'error'], ['Week', '89%', 'warning']])
  w.ctx = { tokens: 800000, window: 1000000, percent: 80 }

  // The pane draws the same tones, at the lines too.
  await limits(75, 90)
  let pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^75%$/ }))?.props.color).toBe('warning')
  expect((await pane.find({ type: 'Text', text: /^90%$/ }))?.props.color).toBe('error')
  await pane.unmount()
  await limits(82.5, 31)
  pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^82\.5%$/ }))?.props.color).toBe('warning')
  expect((await pane.find({ type: 'Text', text: /^31%$/ }))?.props.color).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: /^80%$/ }))?.props.color).toBe('error')
  const svgs = await pane.findAll({ type: 'Svg' })
  expect(String(svgs.find(s => String(s.props.alt).startsWith('Weekly'))?.props.source)).toContain(`fill="${HEX.suggestion}"`)
  await pane.unmount()

  // Cache: a blue dot and the minutes in normal text while warm, amber in the last minutes, red once likely cold.
  const cache = async (dot: string, value: RegExp, valueColour: string | undefined) => {
    for (const surface of SURFACES) {
      const band = await mountBand($, surface)
      expect(await tree(band)).toMatch(new RegExp(`"key":"open-Cache".*?\\{"type":"Text","props":\\{"color":"${dot}"\\},"children":\\["●"\\]\\}`))
      expect((await band.find({ type: 'Text', text: value }))?.props.color).toBe(valueColour)
      await band.unmount()
    }
  }
  await cache('suggestion', /^~60m$/, undefined)
  await w.clock.advance(56 * MIN)
  await cache('warning', /^~4m$/, 'warning')
  await w.clock.advance(5 * MIN)
  await cache('error', /^cold\?$/, 'error')
})

test("Claude's orange marks only Claude at work: the running dot, the ✻ and the running line", async ($, on) => {
  // The queued /compact is held, as the engine holds one until the session is idle, so the compaction can be seen under way.
  const w = world(on, { tokens: 640000, window: 1000000, percent: 64 }, { hold: true })
  await start($)
  await measure($, w, ['context', 'rateLimits', 'cost'])
  const noOrange = async (state: string) => {
    for (const surface of SURFACES) {
      const band = await mountBand($, surface)
      expect([state, surface, /"claude"|#d97757/.exec(await tree(band))?.[0], await sparkShown(band)]).toEqual([state, surface, undefined, false])
      await band.unmount()
    }
  }
  // Claude at work: the dot, the ✻ (the spark on the desktop) and the line are all Claude's orange; the desktop's line glows.
  const atWork = async (state: string, line: RegExp) => {
    const terminal = await mountBand($, 'terminal')
    expect([state, await dotOf(terminal, 'check')]).toEqual([state, 'claude'])
    expect([state, (await terminal.find({ type: 'Text', text: '✻' }))?.props.color]).toEqual([state, 'claude'])
    expect([state, (await terminal.find({ type: 'Text', text: line }))?.props.color]).toEqual([state, 'claude'])
    await terminal.unmount()
    const desktop = await mountBand($, 'desktop')
    expect([state, await dotOf(desktop, 'check')]).toEqual([state, 'claude'])
    const svgs = await desktop.findAll({ type: 'Svg' })
    expect([state, String(svgs.find(s => s.props.alt === 'Running')?.props.source).includes('fill="#d97757"')]).toEqual([state, true])
    const glow = String(svgs.find(s => line.test(String(s.props.alt)))?.props.source)
    expect([state, glow.includes('stop-color="#d97757"')]).toEqual([state, true])
    // The glow is set at the band's caption size, as the still line's text is: 11.5px in an SVG 16 high.
    expect(glow).toContain('font-size="11.5"')
    expect(glow).toMatch(/^<svg [^>]*height="16" viewBox="0 0 \d+ 16">/)
    expect([state, (await desktop.findAll({ type: 'Svg' })).find(s => line.test(String(s.props.alt)))?.props.height]).toEqual([state, 16])
    await desktop.unmount()
  }
  await noOrange('idle')
  await press($, w, 'check')
  await atWork('check running', /^Check running: Claude is testing for a safe spot…$/)
  await desktopTurn($, w, async () => {
    await tool($, 'ready_to_compact', READY)
    await measure($, w)
  })
  // Confirmed and waiting for the session to go idle: nobody is at work, so the dot and a still line are green.
  await noOrange('waiting')
  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    expect([surface, await dotOf(band, 'check'), await lineTone(band, /^Safe spot confirmed\. Compacting when idle…$/)]).toEqual([surface, 'success', 'success'])
    await band.unmount()
  }
  // Compacting: Claude summarises the conversation, so it is Claude at work again.
  await w.clock.advance(1100)
  expect(w.runs.filter(r => r.command === 'compact').length).toBe(1)
  await atWork('compacting', /^Compacting…$/)
  w.release?.()
  await w.clock.advance(2000)
  expect(w.compacts.length).toBe(1)
  await noOrange('compacted')
})
