---
name: live-check
description: Run sidemaid in a real Claude Code session at a given terminal size and look at what it draws (pane docked or inline, auto-open, transcript pointer, image). Use after changing the mod, before a release, or when a report says it renders wrong.
---

# live-check

`claude plugin test` cannot raise a model's reply, so capture, rendering and layout are only seen in a real session. `live-check.sh` starts one with this checkout as `--plugin-dir`, sends `prompt.md` (two fixed diagrams: a tall `flowchart TD` and a wide `classDiagram LR`), and keeps snapshots:

| Snapshot | When |
| --- | --- |
| `1-auto` | After the reply and both renders: did the pane open by itself? |
| `2-asked` | After `/mermaid` |
| `3-prev` | After `p` in the pane: the first diagram |

## Run

From the repository root:

```sh
LIVE_CHECK_CWD=<a folder Claude Code trusts> .claude/skills/live-check/live-check.sh tmux 105 37
LIVE_CHECK_CWD=<a folder Claude Code trusts> .claude/skills/live-check/live-check.sh iterm 160 45
```

- `tmux`: screen text (`*.txt`). tmux shows no pictures, so an `Image` draws its alt (the mermaid source) in its place. Good for layout: docked or inline, what opened, what the transcript shows.
- `iterm` (macOS): a new iTerm2 window at that size, screenshots (`*.png`) plus its text. Shows the real image. The screenshots are taken by `screencapture -l <window>` run from Terminal.app, so Terminal.app needs the Screen Recording permission (iTerm2 does not, and covered windows are captured whole).

Each run uses a fresh render cache, a `haiku` reply (`LIVE_CHECK_MODEL`), and deletes its own session transcript. Output: `$LIVE_CHECK_OUT` (default `$TMPDIR/sidemaid-live-check/<mode>-<cols>x<rows>/`), with `debug.log` and `hook-problems.txt` (sidemaid lines in the debug log that say failed, skipped or refused).

## Sizes worth checking

| Size | Why |
| --- | --- |
| `105 37` | Below 110 columns the terminal never docks a pane: it opens inline above the prompt |
| `120 37` | Docks, but a pane opened unasked waits (below 144) |
| `160 45` | Docks and opens by itself |

## Reading the results

Read every snapshot, then `hook-problems.txt`. A line `<event> bypassed by cc-plugin-sec-default` means an organization's policy plugin runs first and skips the mod's hook for that event: the hook's work never happens in that organization.
