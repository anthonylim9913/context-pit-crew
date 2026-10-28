# Context Pit Crew

A Claude Code mod for long sessions. A mod is a Claude Code plugin built on its mods API. In a long session the context fills up, compaction lands mid-task and drops what mattered, and the usage limits run out unseen. Context Pit Crew puts context, limits, cache and cost above the prompt, and adds controls to compact or move to a fresh session at a moment Claude has checked.

**What it helps you do**
- See context fill, the 5-hour and weekly usage limits, an estimate of prompt-cache warmth and the session's cost above the prompt, without running `/context` or `/usage`.
- Compact at a moment Claude has checked: nothing half-done, nothing waiting on you, and the state page current if you keep one.
- Hand a session off to a fresh one with a short brief, instead of compacting a summary of a summary.

A *state page* is a short start-here file that a session keeps current: what is running, what waits on you, and the next step. A fresh or compacted session picks up from it. The `STATUS.md` from [project-docs-protocol](https://github.com/anthonylim9913/project-docs-protocol) is one. Context Pit Crew works without one.

**What it does not do**
- It cannot raise your limits or make Claude read less.
- The safe-spot check is Claude's own judgment, not a guarantee.
- It gates only the compactions it starts. Claude Code's own automatic compaction and a `/compact` you type still happen as before.
- It never starts a new session by itself. You click the card.
- The Cache figure is an estimate from a setting, not a reading. Claude Code does not report your cache lifetime.
- The Cost figure is the API-equivalent cost as Claude Code estimates it, not a charge.

**Not yet seen working live**
- The buttons' hover tips in the desktop app. `/pit-crew help` lists the same text.
- How the desktop app draws the Auto menu, whether the meter names draw dim, and whether all five meters fit on one line at your window's width.
- The VS Code and mobile surfaces. The spacing there has not been measured.
- The setup guide. Its install commands have been tried against a local copy of this repository, but not yet from GitHub, and the guide has not yet been run from start to finish.

## Requirements

- A Claude Code build with the mods API. Context Pit Crew is developed and tested on Claude Code 2.1.308 in the Claude desktop app (Code tab) on macOS. In a terminal session the same controls draw as text, with block-character bars.
- The `claude` on your PATH can be a different build from the one the desktop app ships. If a `claude plugin` command fails, use the app's own build, or install from inside the app (see below).
- For the setup guide: `git`, and `python3` (3.9 or newer) for the checks that project-docs-protocol's Install and Doctor run. The guide's shell commands are for macOS and Linux. On Windows it installs Context Pit Crew and stops before the skill and the project docs.

## Set up with Claude

Paste this line into Claude Code, in the project folder where you want project docs:

```
Set up Context Pit Crew by following https://github.com/anthonylim9913/context-pit-crew/blob/main/SETUP.md
```

Claude follows [SETUP.md](SETUP.md). It does three things:
1. It installs Context Pit Crew for your user account, so the mod loads in every project. If Context Pit Crew is already installed, it updates it. If you already have a different marketplace called `context-pit-crew`, such as your own copy, it asks before going on.
2. It installs the project-docs-protocol skill into `~/.claude/skills/project-docs-protocol` (under `CLAUDE_CONFIG_DIR` if you set that). If something is already there, it leaves it alone. The one exception is a clean checkout of that repository on its main branch, which it fast-forwards. It never pulls through a symlink.
3. It sets up project docs in the current folder by running that skill's Install, which asks you a few questions. If the folder already uses the protocol, Claude runs a read-only check instead. If the folder is your home folder or a system folder, Claude first asks which project to use.

It uses no sudo and pushes nothing. It changes no other plugin, except that it offers to turn off another copy of Context Pit Crew if one is on, and only with your yes. At the end it asks you to type `/reload-plugins`, then reports what changed and how to undo each change. Claude asks before running each command unless your session allows them. Read SETUP.md first to see every command.

If Claude cannot open the page, give it the raw file instead: `https://raw.githubusercontent.com/anthonylim9913/context-pit-crew/main/SETUP.md`.

## Install by hand

From a shell:

```bash
claude plugin marketplace add anthonylim9913/context-pit-crew
claude plugin install context-pit-crew@context-pit-crew --scope user
```

Then type `/reload-plugins` in an open session, or start a new one.

At the prompt of a Claude Code terminal session you can instead run `/plugin install context-pit-crew --marketplace anthonylim9913/context-pit-crew`. Answer `y` to add the marketplace, then pick a scope (user is the usual one).

In the desktop app, where `/plugin` does not run, click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace**, enter `anthonylim9913/context-pit-crew`, then click **Add plugin**.

To update:

```bash
claude plugin marketplace update context-pit-crew
claude plugin update context-pit-crew@context-pit-crew --scope user
```

## The band

The band sits above the prompt. The Usage pane shows the same figures in more detail.

- **The meter row: Context, 5h, Week, Cache and Cost.** Each name is followed closely by its short bar and figures, so all five can share one line. Clicking a label opens the Usage pane at that section: the context by category, or the limits.
  - **5h** and **Week**: if a reading leaves a limit out, the meter keeps its last figures until that limit's reset time passes, then goes away, even if no new reading comes. This covers only a limit the session has already read. A limit Claude Code has not reported in this session is not shown.
  - **Cache** is an estimate, not a reading, so it shows as `~55m`: a countdown from your last reply, using the `cacheTtlMinutes` setting.
  - **Cost** is the session's API-equivalent cost as Claude Code estimates it, not a charge.
- **The controls** come in two groups: **Check & compact** with the **Auto** menu close beside it, then a wider gap, then **New session** and **Refresh**. Each button is meant to show a one-line tip just above it while the pointer is on it. This works on pointer surfaces only and is not yet confirmed in the desktop app.
- **Check & compact**: Claude tests whether this is a safe spot: nothing half-done, no question waiting on you, background work running on its own. It also refreshes the state page if the session keeps one. Only if the test passes does the mod compact. A half-done step is parked with a note, not finished. Pressed while a confirmed compaction waits, it compacts at once.
- **New session**: the same test. Then Claude updates the state page, writes a short handoff brief and proposes a "Continue:" card, which you click to start a fresh session. The new session works in the same folder and branch, so don't work in both at once, and don't archive the old one while the new one is working. Outside the desktop app, Claude prints the brief for you to paste into a new session.
- **Refresh**: re-reads the figures and reloads every installed mod (`/reload-plugins`). It skips the reload while Claude works, or while a check, handoff or compaction is under way or waiting. Some sessions refuse a reload started by a plugin. The status line then quotes the reply, and a new session loads the updated mods.
- **Auto** reads `Auto 60%` or `Auto Off`, and presses Check & compact for you.
  - Click it for a menu, like the footer's effort menu: Off, 50, 60, 70 or 80%, with the current setting selected.
  - When on, the check runs by itself once a turn ends past the level picked, at most once between compactions. After two compactions of any kind, Claude Code's own included, it runs New session instead.
  - `/pit-crew auto N` (or `auto N%`) sets any whole level from 1 to 99, and the menu then lists that level in its place. Anything else after `auto`, such as `auto 100`, `auto 1.5` or `auto -5`, is refused with a reminder of the range.
  - Until you pick a level, it is the `contextCompact` setting.
  - Auto and its level are saved. A session that is already open keeps its own setting until it restarts, and new sessions start with the saved one.
  - The mobile app draws no menu, so there Auto is a plain button. Each press steps to the next level, and the press after the last turns Auto off.
- **A dot before each of the two check buttons** shows its state:
  - grey: idle
  - orange: Claude is working on it (the check, the handoff or the compaction), in Claude's working colour
  - green: confirmed
  - red: not safe, or a compaction that did not start
  - amber: a new session is suggested

  `/pit-crew help` lists what each button does. The buttons have no letter hotkeys.
- The figures, the state dots and the status line are drawn a size smaller than the names and buttons.
- **When a press is refused:** Check & compact and New session refuse a press, with a short message, while Claude is working or while a check or compaction is under way. A check with no verdict ends when its turn ends, or after 10 minutes with no turn running. A check or handoff that Claude Code refuses to start ends at once (a reached usage limit, say), and the band says why: "The check did not start: <reason>." (or "The handoff did not start: <reason>.").
- **When a compaction runs:** a confirmed compaction is queued only once Claude's turn has ended. Typing a message before it runs drops it. In the terminal, stopping the turn also drops it. The desktop app does not report a stop, so there a confirmed compaction still runs; type a message to drop it.

**What it costs:** each Check & compact, New session or Auto run is one model turn over the whole context, which counts against your limits. Auto spends it without a prompt from you. On the desktop the mod cannot tell a turn you stopped from one that finished, so Auto may start its check right after you press stop.

## What it does to a session

- **Context notes.** When context first crosses each line (50, 60 and 75% by default), the mod adds a short note to your next prompt. Each note tells Claude to do what you asked first.
  - At 50% it asks Claude to refresh the state page if the session keeps one, or to offer to start one.
  - At 60% it asks Claude to tell you when a good spot comes.
  - At 75% it asks Claude to suggest compacting before long work.

  The notes ride only on your own next message. A background notification, a scheduled prompt, another session's message, or a prompt that another plugin sends as its own carries none, and leaves them for your message.
- **A keep line on every compaction.** It adds "keep the state page, pending decisions, background tasks and the next step; drop captured output" to the instructions of every compaction, including Claude Code's own and a `/compact` you type.
- **A note after its own compactions.** After a compaction the mod itself ran, your next prompt carries a note: answer you first, then read the state page if the work continues.
- **Four tools.** It registers `ready_to_compact`, `not_safe_to_compact`, `ready_to_hand_off` and `suggest_new_session`. Claude calls the first three only during a check or handoff. It can call `suggest_new_session` during normal work when the topic has moved on, which only shows a suggestion and a toast.
- **Prompts from the buttons.** New session's prompt is sent as your words. Check & compact and Auto submit as the plugin.
- **Project docs.** In a project that already uses [project-docs-protocol](https://github.com/anthonylim9913/project-docs-protocol), the check and handoff update STATUS and CHANGELOG in that protocol's format. Otherwise they use the state page the session already keeps. Without one, Claude creates none unasked, and carries the next step in the compaction plan or the handoff brief instead.
- **Toasts, always on:**
  - when context or a limit first crosses 75% or 90%, one per meter per reading
  - when the prompt cache is about to go cold
  - for button results: a check or handoff starting or refused, a compaction confirmed or failed, a new session ready, a suggestion, a reload
- **Files on disk.** It saves your Auto choice and level in the plugin's store. With `diagnostics` on, it also writes `/tmp/claude-mods-diag/context-pit-crew-<session>.json`, which records what the mod did and when, never text Claude wrote. It makes no network requests of its own.

## Commands

`/pit-crew` opens the pane. The full set is `/pit-crew check | handoff | refresh | auto on | auto off | auto N | help`.

## Configuration

These options are in the plugin's settings. To list them and see which you have set, run:

```bash
claude plugin configure context-pit-crew@context-pit-crew
```

To set an option, pass the values as JSON strings, for example:

```bash
echo '{"cacheTtlMinutes":"5"}' | claude plugin configure context-pit-crew@context-pit-crew --values-stdin
```

In a terminal session, `/plugin configure context-pit-crew@context-pit-crew` does the same. A changed option applies from the next session.

| Option | Default | What it sets |
|---|---|---|
| `diagnostics` | false | A per-session breadcrumb file for debugging |
| `openPaneOnStart` | false | Opens the Usage pane when a session starts |
| `cacheTtlMinutes` | 60 | Your prompt-cache lifetime: 60 for the 1-hour cache, 5 for the 5-minute cache |
| `contextWatch` | 40 | The context % where the band starts advising a good spot |
| `contextStatePage` | 50 | The context % where Claude is reminded of the state page |
| `contextCompact` | 60 | The context % where Claude is asked to point out the next good spot, and Auto's level until you pick one |
| `contextOverdue` | 75 | The context % where compacting is overdue |

The four context lines must rise in that order, or all four use their defaults.

## Turn it off or uninstall

To turn it off: `claude plugin disable context-pit-crew@context-pit-crew`. With Auto off and the buttons left alone, the mod submits no prompts. These stay on until you disable the plugin:
- the context notes
- the keep line added to every compaction
- the note after its own compactions
- the `suggest_new_session` tool
- the toasts

To remove it:

```bash
claude plugin uninstall context-pit-crew@context-pit-crew
claude plugin marketplace remove context-pit-crew
```

Removing the last install of Context Pit Crew also removes its options. Add `--keep-data` to keep its saved data (the Auto setting).

The project-docs-protocol skill and any project docs that the setup guide created are separate. Remove them yourself if you don't want them. SETUP.md's final report lists them.

## Developing

The mod is in `plugin/`. Check it with the same Claude Code build that runs it:

```bash
claude plugin validate plugin
claude plugin test plugin
claude plugin validate .
```

Bump `version` in `plugin/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json` together for every release, so installed copies pick up the update.

## Changelog

- **1.1.0**: first release in its own repository, under the name Context Pit Crew (it was developed as usage-meter; its command is now `/pit-crew`, no longer `/usage-meter`). Earlier versions stayed numbered 1.0.0 while the code changed, so this release moves the version to 1.1.0.

## License

MIT. See [LICENSE](LICENSE).
