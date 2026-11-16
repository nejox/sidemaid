"""Records the README's before/after GIF in two real iTerm2 windows (macOS).

    uv run --with pillow --with pyyaml .claude/skills/demo-gif/demo.py [storyboard.yml]

Each scene's prompt is typed into both windows (one session without sidemaid,
one with this checkout as --plugin-dir), a frame is kept of each side with the
prompt typed and again once the reply and its renders are done. The frames are
set side by side under their labels, cross-faded, and written to docs/demo.gif.
Screenshots are taken by `screencapture -l` run from Terminal.app, so Terminal.app
needs the Screen Recording permission.
"""

import json
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import yaml
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = Path(subprocess.check_output(['git', '-C', str(HERE), 'rev-parse', '--show-toplevel'], text=True).strip())
PROJECTS = Path.home() / '.claude' / 'projects'
BACKGROUND = (24, 26, 33)
LABEL = (205, 210, 225)
FADE_STEPS = 5
FADE_MS = 40
FONTS = ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc',
         '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']


def osa(script):
    return subprocess.run(['osascript', '-e', script], capture_output=True, text=True, check=True).stdout.strip()


def quoted(text):
    return '"' + text.replace('\\', '\\\\').replace('"', '\\"') + '"'


def wait(what, check, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return
        time.sleep(0.5)
    raise TimeoutError(f'{what}: not within {seconds} s')


class Side:
    """One iTerm2 window running one Claude Code session."""

    def __init__(self, side, board, run):
        self.label = side['label']
        self.plugin = side['plugin']
        self.dir = run / re.sub(r'\W+', '-', self.label.lower()).strip('-')
        self.cache = self.dir / 'cache'
        self.cache.mkdir(parents=True)
        settings = self.dir / 'settings.json'
        # A blank status line keeps the person's own (paths, usage) out of the frames;
        # an installed sidemaid stays off so only --plugin-dir decides.
        settings.write_text(json.dumps({
            'statusLine': {'type': 'command', 'command': 'printf ""'},
            'enabledPlugins': {'sidemaid@sidemaid': False},
            'promptSuggestionEnabled': False,
        }))
        claude = ['claude', '--model', board['model'], '-n', TITLE,
                  '--settings', str(settings)] + (['--plugin-dir', str(REPO)] if self.plugin else [])
        script = self.dir / 'run.sh'
        script.write_text(f'cd {shlex.quote(str(Path(board["cwd"]).expanduser()))}\n'
                          f'export XDG_CACHE_HOME={shlex.quote(str(self.cache))}\n'
                          f'exec {shlex.join(claude)}\n')
        columns, rows = board['size']
        self.window = osa(f'''tell application "iTerm2"
  set w to (create window with default profile)
  tell current session of w
    set columns to {columns}
    set rows to {rows}
    write text {quoted("bash " + shlex.quote(str(script)))}
  end tell
  return id of w
end tell''')

    def tell(self, command):
        return osa(f'tell application "iTerm2" to tell current session of (window id {self.window}) to {command}')

    def screen(self):
        return self.tell('get contents')

    def type(self, text):
        self.tell(f'write text {quoted(text)} newline no')

    def enter(self):
        self.tell('write text ""')

    def is_done(self, prompt):
        """The reply to prompt is finished: a `· done` line follows its echo."""
        screen = self.screen()
        echo = screen.rfind(prompt[:40])
        return echo >= 0 and '· done' in screen[echo:]

    def is_rendered(self, since):
        """With sidemaid, the reply's diagram is rendered and drawn in the pane."""
        if not self.plugin:
            return True
        pngs = [path.stat().st_mtime for path in self.cache.glob('*/*.png')]
        return bool(pngs) and max(pngs) > since and 'rendering…' not in self.screen()

    def snap(self, path):
        tab = osa(f'tell application "Terminal" to do script '
                  f'{quoted(f"screencapture -x -o -l {self.window} {shlex.quote(str(path))}; exit")}')
        wait(f'screenshot {path.name}', lambda: path.exists() and path.stat().st_size > 0, 15)
        osa(f'tell application "Terminal" to close (window id {tab.split("window id ")[-1]})')

    def close(self):
        try:
            osa(f'tell application "iTerm2" to close (window id {self.window})')
        except subprocess.CalledProcessError:
            pass


TITLE = 'sidemaid-demo'


def drop_transcripts(since, prompt):
    """The sessions were a recording: delete their transcripts, the ones before /clear by
    the session's name and the ones after it by the demo's prompt."""
    # A closing session writes its transcript once more on the way out: look twice.
    for _ in range(2):
        time.sleep(5)
        for path in PROJECTS.glob('*/*.jsonl'):
            # Created during the recording: never the transcript of a session that was already
            # running, such as the one that started this script.
            stat = path.stat()
            text = path.read_text(errors='ignore')
            is_demo = prompt in text or f'"customTitle":"{TITLE}"' in text
            if getattr(stat, 'st_birthtime', stat.st_ctime) >= since and is_demo:
                subprocess.run(['rm', '-rf', str(path), str(path.with_suffix(''))], check=False)


def font(size):
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def compose(shots, labels, board):
    width = board['width']
    gap = 24
    side_width = (width - 3 * gap) // 2
    crops = []
    for shot in shots:
        image = Image.open(shot).convert('RGB')
        image = image.crop((0, board['crop']['top'], image.width, image.height - board['crop']['bottom']))
        crops.append(image.resize((side_width, round(image.height * side_width / image.width)), Image.LANCZOS))
    title = font(30)
    label_height = 64
    height = label_height + max(image.height for image in crops) + gap
    canvas = Image.new('RGB', (width, height), BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    for i, (image, label) in enumerate(zip(crops, labels)):
        left = gap + i * (side_width + gap)
        draw.text((left + side_width / 2, label_height / 2), label, font=title, fill=LABEL, anchor='mm')
        canvas.paste(image, (left, label_height))
    return canvas


def write_gif(frames, path):
    """frames: [(image, milliseconds)]; consecutive stills are cross-faded."""
    timeline = []
    for i, (image, ms) in enumerate(frames):
        timeline.append((image, ms))
        following = frames[(i + 1) % len(frames)][0]
        for step in range(1, FADE_STEPS + 1):
            timeline.append((Image.blend(image, following, step / (FADE_STEPS + 1)), FADE_MS))
    # One palette for every frame, taken from the stills, keeps the GIF small and steady.
    sample = Image.new('RGB', (frames[0][0].width, frames[0][0].height * len(frames)))
    for i, (image, _) in enumerate(frames):
        sample.paste(image, (0, i * image.height))
    palette = sample.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    images = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image, _ in timeline]
    images[0].save(path, save_all=True, append_images=images[1:], duration=[ms for _, ms in timeline],
                   loop=0, optimize=True, disposal=1)


def main():
    board = yaml.safe_load(Path(sys.argv[1] if len(sys.argv) > 1 else HERE / 'storyboard.yml').read_text())
    run = Path(tempfile.mkdtemp(prefix='sidemaid-demo-'))
    started = time.time()
    prompts = [' '.join(scene['prompt'].split()) for scene in board['scenes']]
    terminal_ran = subprocess.run(['pgrep', '-x', 'Terminal'], capture_output=True).returncode == 0
    sides = [Side(side, board, run) for side in board['sides']]
    labels = [side.label for side in sides]
    frames = []
    try:
        for side in sides:
            wait(f'{side.label} start', lambda side=side: 'Claude Code' in side.screen(), 60)
        # A clean transcript: no header, and no notice an organization's plugin raised at start.
        for side in sides:
            side.type('/clear')
            side.enter()
        time.sleep(4)
        for n, (scene, prompt) in enumerate(zip(board['scenes'], prompts), start=1):
            for side in sides:
                side.type(prompt)
            time.sleep(1)
            typed = [side.dir / f'{n}-typed.png' for side in sides]
            for side, path in zip(sides, typed):
                side.snap(path)
            frames.append((compose(typed, labels, board), int(scene['typed'] * 1000)))

            entered = time.time()
            for side in sides:
                side.enter()
            for side in sides:
                wait(f'{side.label} reply {n}', lambda side=side: side.is_done(prompt), 180)
                wait(f'{side.label} renders {n}', lambda side=side: side.is_rendered(entered), 90)
            time.sleep(2)
            replied = [side.dir / f'{n}-reply.png' for side in sides]
            for side, path in zip(sides, replied):
                side.snap(path)
            frames.append((compose(replied, labels, board), int(scene['reply'] * 1000)))
    finally:
        for side in sides:
            (side.dir / 'screen.txt').write_text(side.screen())
            side.close()
        if not terminal_ran:
            subprocess.run(['osascript', '-e', 'tell application "Terminal" to quit'], check=False)
        drop_transcripts(started, prompts[0])

    for i, (image, _) in enumerate(frames):
        image.save(run / f'frame-{i}.png')
    out = REPO / 'docs' / 'demo.gif'
    out.parent.mkdir(exist_ok=True)
    write_gif(frames, out)
    print(f'{out} ({out.stat().st_size // 1024} KB), frames in {run}')


if __name__ == '__main__':
    main()
