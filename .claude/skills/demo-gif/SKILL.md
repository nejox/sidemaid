---
name: demo-gif
description: Record the README's before/after GIF (docs/demo.gif) in two real iTerm2 windows, one session without sidemaid and one with this checkout. Use after a visible change to the pane or the transcript pointer, or before a release.
---

# demo-gif

`demo.py` plays `storyboard.yml` in two iTerm2 windows side by side: the same prompts, left without sidemaid, right with this checkout as `--plugin-dir`. For each scene it keeps a frame of both with the prompt typed and one once the replies (and, on the right, the renders) are done, sets them side by side under their labels, cross-fades them and writes `docs/demo.gif`.

## Run

From the repository root, on macOS with iTerm2:

```sh
uv run --with pillow --with pyyaml .claude/skills/demo-gif/demo.py
```

- Two iTerm2 windows open for about two minutes; leave them be.
- Screenshots come from `screencapture -l <window>` run through Terminal.app, so Terminal.app needs the Screen Recording permission (iTerm2 does not, and covered windows are captured whole).
- The frames stay in a temp folder the script prints. Read the stills (`frame-*.png`) before committing the GIF.

## What keeps the frames clean

- A blank status line, no prompt suggestions, and an installed sidemaid switched off, through `--settings`.
- `/clear` before the first scene, so the session header and start-up notices are gone.
- The window chrome is cut by `crop` in the storyboard; adjust it to the iTerm2 profile in use.
- The sessions' transcripts are deleted afterwards (by the session name before `/clear`, by the demo prompt after it, and only files created during the run).

## Before committing

Check every still for private data: the session header's folder, anything a reply read from disk, a toast. The storyboard's `cwd` shows in the header; keep the prompts on invented, neutral content.
