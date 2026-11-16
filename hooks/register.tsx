import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderSurface } from 'claude-code'

import type { Diagram } from '../types'

const PANE = 'mermaid'
const TITLE = 'Mermaid'
const KEEP = 30
// An Image takes at most 2 MiB of PNG: about this much base64.
const MAX_BASE64 = 2_796_000

// Change the tag when a diagram's fields change: it declines what an earlier
// version stored, which outlives a reload.
const diagrams = atom({ plugin: 'mermaid-pane', key: 'diagrams' } as const, [], {
  shape: 'diagrams-1',
})
const selected = atom({ plugin: 'mermaid-pane', key: 'selected' } as const, null)

// A fenced mermaid block, ``` or ~~~. Adapted from ccmermaid (MIT),
// https://github.com/weichieh0204/ccmermaid
const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/gm

const MISSING_MMDC = 'mmdc not found. Install it with: npm i -g @mermaid-js/mermaid-cli'

const HINT = [
  'Mermaid code blocks you write are rendered as images in a narrow side pane of the',
  "user's terminal. When you draw one, prefer `flowchart TD` over `LR`, keep it under",
  'about 25 nodes, and give it a title on its first line as `%% title: <title>`.',
].join(' ')

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

type Settings = {
  theme: string
  autoOpen: boolean
  collapseInTranscript: boolean
  promptHint: boolean
  saveDir: string
  mmdcPath: string
  chromePath: string
}

type Renderer = { cacheDir: string; mmdc: string; flags: readonly string[] }

function settingsOf(options: PluginOptions): Settings {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] !== '' ? (options[key] as string) : fallback
  const flag = (key: string) => options[key] !== false

  return {
    theme: text('theme', 'dark'),
    autoOpen: flag('autoOpen'),
    collapseInTranscript: flag('collapseInTranscript'),
    promptHint: flag('promptHint'),
    saveDir: text('saveDir', 'docs/diagrams'),
    mmdcPath: text('mmdcPath', 'mmdc'),
    chromePath: text('chromePath', ''),
  }
}

export function mermaidBlocks(text: string): string[] {
  return [...text.matchAll(FENCE)].flatMap(match => (match[2] === undefined ? [] : [match[2]]))
}

export function titleOf(source: string, id: number): string {
  const named =
    /^\s*%%\s*title:\s*(.+?)\s*$/m.exec(source) ??
    /^\s*---\s*\n[\s\S]*?^\s*title:\s*(.+?)\s*$[\s\S]*?^\s*---\s*$/m.exec(source)
  if (named?.[1]) return named[1]

  const body = source.replace(/^\s*---[\s\S]*?^\s*---\s*$/m, '').replace(/^\s*%%.*$/gm, '')
  const kind = /^\s*([A-Za-z][\w-]*)/m.exec(body)?.[1] ?? 'diagram'

  return `${kind} #${id}`
}

// FNV-1a: names a render by its theme and source.
function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// A PNG's IHDR holds its width and height at bytes 16 and 20: the first 32
// base64 characters are its first 24 bytes.
export function pngSize(base64: string): { width: number; height: number } {
  const bytes: number[] = []
  for (let i = 0; i < 32; i += 4) {
    const word = [...base64.slice(i, i + 4)].reduce((acc, char) => (acc << 6) | BASE64.indexOf(char), 0)
    bytes.push((word >> 16) & 255, (word >> 8) & 255, word & 255)
  }
  const uint32 = (at: number) => bytes.slice(at, at + 4).reduce((acc, byte) => acc * 256 + byte, 0)

  return { width: uint32(16), height: uint32(20) }
}

// mmdc prints the parse error first, then a stack: keep the error.
export function errorOf(stderr: string): string {
  const lines = stderr.split('\n')
  const stack = lines.findIndex(line => /^\s+at |\(\w+:\/\//.test(line))
  const kept = (stack < 0 ? lines : lines.slice(0, stack)).filter(line => line.trim() !== '')

  return kept.slice(0, 6).join('\n') || 'mmdc failed without a message'
}

// Terminal cells are about twice as tall as wide.
const CELL_ASPECT = 0.5

export function fit(
  width: number,
  height: number,
  columns: number,
  rows: number,
): { columns: number; rows: number } {
  const ratio = (height / width) * CELL_ASPECT
  // mmdc renders at twice the scale; about 7 px per cell keeps a small diagram small.
  const natural = Math.ceil(width / 2 / 7)
  let cols = Math.max(1, Math.min(columns, natural, 255))
  let tall = Math.max(1, Math.round(cols * ratio))
  if (tall > rows) {
    tall = Math.max(1, rows)
    cols = Math.max(1, Math.min(cols, Math.round(tall / ratio)))
  }

  return { columns: cols, rows: Math.min(tall, 255) }
}

function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'diagram'
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function rendererOf($: EngineInterface, settings: Settings): Promise<Renderer> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const cacheDir = `${(await $.env.get('XDG_CACHE_HOME')) ?? `${home}/.cache`}/mermaid-pane`
  const mmdc = settings.mmdcPath
  const flags = ['-t', settings.theme, '-b', 'transparent', '-s', '2', '-q']

  let chrome = settings.chromePath
  if (chrome === '' && (await $.env.get('PUPPETEER_EXECUTABLE_PATH')) === undefined) {
    for (const candidate of CHROMES) {
      if (await $.fs.exists(candidate)) {
        chrome = candidate
        break
      }
    }
  }
  if (chrome === '') return { cacheDir, mmdc, flags }

  const config = `${cacheDir}/puppeteer.json`
  await $.fs.write(config, JSON.stringify({ executablePath: chrome }))

  return { cacheDir, mmdc, flags: [...flags, '-p', config] }
}

// One per load: a reload runs register again in a fresh environment.
let renderer: Promise<Renderer> | undefined

function rendererFor($: EngineInterface, settings: Settings): Promise<Renderer> {
  renderer ??= rendererOf($, settings).catch(err => {
    renderer = undefined
    throw err
  })

  return renderer
}

async function finish($: EngineInterface, id: number, change: Partial<Diagram>) {
  await update($, diagrams, list => list.map(one => (one.id === id ? { ...one, ...change } : one)))
}

async function renderOne($: EngineInterface, settings: Settings, diagram: Diagram) {
  try {
    const setup = await rendererFor($, settings)
    const base = `${setup.cacheDir}/${diagram.hash}`
    const png = `${base}.png`
    if (!(await $.fs.exists(png))) {
      await $.fs.write(`${base}.mmd`, diagram.source)
      const argv = [setup.mmdc, '-i', `${base}.mmd`, '-o', png, ...setup.flags]
      const ran = await $.process.run(argv, {
        timeoutMs: 60_000,
      })
      if (ran.exitCode !== 0) {
        await finish($, diagram.id, { status: 'error', error: errorOf(ran.stderr) })
        return
      }
    }
    const { base64 } = await $.fs.read(png, { as: 'bytes' })
    await finish($, diagram.id, { status: 'ok', png, ...pngSize(base64) })
  } catch (err) {
    const message = messageOf(err)
    const isMissing = /ENOENT|not found|cannot start/i.test(message)
    await finish($, diagram.id, { status: 'error', error: isMissing ? MISSING_MMDC : message })
  }
}


// The blocks of a reply that are not in the list yet, numbered on from its last.
export function newDiagrams(list: readonly Diagram[], sources: readonly string[], theme: string): Diagram[] {
  let id = list.at(-1)?.id ?? 0

  return sources
    .filter((source, i) => sources.indexOf(source) === i)
    .filter(source => !list.some(one => one.source === source))
    .map(source => {
      id += 1
      return { id, title: titleOf(source, id), source, hash: hashOf(`${theme}\n${source}`), status: 'rendering' }
    })
}

async function capture($: EngineInterface, settings: Settings, sources: readonly string[]) {
  let added: Diagram[] = []
  await update($, diagrams, list => {
    added = newDiagrams(list, sources, settings.theme)

    return [...list, ...added].slice(-KEEP)
  })
  if (added.length === 0) return

  await update($, selected, () => null)
  if (settings.autoOpen) void $.ui.open({ id: PANE, title: TITLE })
  for (const diagram of added) await renderOne($, settings, diagram)
}

async function page($: EngineInterface, step: number) {
  const list = await read($, diagrams)
  await update($, selected, current => {
    const at = current === null ? list.length - 1 : list.findIndex(one => one.id === current)
    const to = Math.min(list.length - 1, Math.max(0, at + step))

    return to === list.length - 1 ? null : (list[to]?.id ?? null)
  })
}

async function copySource($: EngineInterface, surface: RenderSurface, diagram: Diagram) {
  const copied = await $.ui.copy({ text: diagram.source, surface })
  $.ui.toast(copied.isCopied ? 'Copied the mermaid source' : `Copy failed (${copied.reason})`)
}

async function openPng($: EngineInterface, diagram: Diagram) {
  if (diagram.png === undefined) return
  for (const opener of ['open', 'xdg-open']) {
    const ran = await $.process.run([opener, diagram.png]).catch(() => undefined)
    if (ran?.exitCode === 0) return
  }
  $.ui.toast(`Could not open ${diagram.png}`)
}

async function save($: EngineInterface, settings: Settings, diagram: Diagram) {
  const base = `${settings.saveDir}/${slugOf(diagram.title)}`
  try {
    await $.fs.write(`${base}.mmd`, `${diagram.source}\n`)
    const copied = diagram.png ? await $.process.run(['cp', diagram.png, `${base}.png`]) : undefined
    $.ui.toast(copied?.exitCode === 0 ? `Saved ${base}.mmd and .png` : `Saved ${base}.mmd`)
  } catch (err) {
    $.ui.toast(`Save failed (${messageOf(err)})`)
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mermaid',
      description: 'Show the Mermaid diagram pane; /mermaid clear empties it',
      argumentHint: '[clear]',
    })

    return next(e)
  })

  on('command.run', { command: 'mermaid' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, diagrams, () => [])
      await update($, selected, () => null)

      return { text: 'Mermaid pane cleared.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    if (!opened.isPlaced) return { text: `The Mermaid pane could not open: ${opened.reason}` }

    return { text: 'Mermaid pane: p/n page, c copy, o open, s save, esc back to the prompt.' }
  })

  // Every block of the model's reply passes here once, as it is kept.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    if (e.origin.kind === 'model' && e.agentId === undefined) {
      const sources = e.message.content.flatMap(block =>
        block.type === 'text' && typeof block.text === 'string' ? mermaidBlocks(block.text) : [],
      )
      // Rendering takes seconds: the row is stored without waiting for it.
      if (sources.length > 0) void capture($, settings, sources)
    }

    return kept
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!settings.promptHint || !e.surfaces.includes('terminal')) return composed

    return {
      sections: [...composed.sections, { id: 'mermaid-pane:hint', text: HINT, scope: 'session' }],
    }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const isCollapsed =
      settings.collapseInTranscript && e.surface === 'terminal' && mermaidBlocks(e.props.text).length > 0
    if (!isCollapsed) return next(e)

    const list = await read($, diagrams)
    const text = e.props.text.replace(FENCE, (_block, _fence, source: string) => {
      const diagram = list.find(one => one.source === source)
      const name = diagram ? `#${diagram.id} ${diagram.title}` : 'diagram'

      return `◧ *Mermaid ${name}, in the pane (/mermaid)*`
    })

    return next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, diagrams)
    if (list.length === 0) return <Text dimColor>No diagrams yet. Ask Claude for a mermaid diagram.</Text>

    const pinned = await read($, selected)
    const found = list.findIndex(one => one.id === pinned)
    const at = found < 0 ? list.length - 1 : found
    const diagram = list[at]
    if (diagram === undefined) return <Text dimColor>No diagram selected.</Text>
    const columns = e.props.bodyColumns
    // Header, buttons and a blank row between each.
    const room = Math.max(3, e.props.scroll.bodyRows - 4)

    let body
    if (diagram.status === 'rendering') {
      body = <Text dimColor>rendering…</Text>
    } else if (diagram.status === 'error') {
      body = (
        <Box flexDirection="column">
          <Text color="red">{diagram.error}</Text>
          <Text dimColor>{diagram.source}</Text>
        </Box>
      )
    } else if (e.surface === 'terminal' && diagram.png && diagram.width && diagram.height) {
      const { Image } = $.ui.resolve(e)
      // A read past 4 MiB rejects; an Image past 2 MiB is refused.
      const bytes = await $.fs.read(diagram.png, { as: 'bytes' }).catch(() => undefined)
      const size = fit(diagram.width, diagram.height, columns, room)
      // The alt shows where the terminal draws no pictures: the source is the next best thing.
      body =
        bytes === undefined || bytes.base64.length > MAX_BASE64 ? (
          <Text dimColor>Too large to draw here: press o to open it.</Text>
        ) : (
          <Image key="diagram" source={{ png: bytes.base64 }} alt={diagram.source} {...size} />
        )
    } else {
      body = <Text>{diagram.source}</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold wrap="truncate-end">
          #{diagram.id} {diagram.title}{' '}
          <Text dimColor>
            ({at + 1}/{list.length})
          </Text>
        </Text>
        {body}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="prev" plain hotkey="p" label="prev" onPress={() => page($, -1)} />
          <Button key="next" plain hotkey="n" label="next" onPress={() => page($, 1)} />
          <Button
            key="copy"
            plain
            hotkey="c"
            label="copy"
            onPress={press => copySource($, press.surface, diagram)}
          />
          {diagram.png !== undefined ? (
            <Button key="open" plain hotkey="o" label="open" onPress={() => openPng($, diagram)} />
          ) : null}
          <Button key="save" plain hotkey="s" label="save" onPress={() => save($, settings, diagram)} />
        </Box>
      </Box>
    )
  })
}
