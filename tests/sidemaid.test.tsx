import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { errorOf, fit, mermaidBlocks, newDiagrams, pngSize, titleOf } from '../hooks/register'
import type { Diagram } from '../types'

// The first bytes of a real 1568×220 PNG that mmdc rendered.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAABiAAAADcCAYAAAD5n2nV'

const FLOW = '%% title: Data flow\nflowchart TD\n  A[Raw] --> B[Features]'
const SEQUENCE = 'sequenceDiagram\n  A->>B: hi'
const REPLY = `Here it is:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\nDone.`

const PANE = {
  plugin: 'sidemaid',
  component: 'Pane',
  requestId: 'mermaid',
  props: {
    title: 'Mermaid',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RENDERED: Diagram[] = [
  { id: 1, title: 'Data flow', source: FLOW, hash: 'a', status: 'ok', png: '/c/a.png', width: 1568, height: 220 },
  { id: 2, title: 'Broken', source: 'flowchart TD\n  A -->', hash: 'b', status: 'error', error: 'Error: Parse error on line 2:' },
]

// What an earlier dispatch stored: the pane reads it as the session would.
function seed(on: On, list: Diagram[]) {
  on('state.get', { key: 'diagrams' }, () => ({
    value: { value: { shape: 'diagrams-1', value: list }, version: 1 },
  }))
  on('fs.read', () => ({ value: { base64: PNG } }))
}

test('finds mermaid blocks and names them', () => {
  expect(mermaidBlocks(REPLY)).toEqual([FLOW])
  expect(mermaidBlocks('~~~mermaid\nflowchart TD\n  A --> B\n~~~')).toEqual(['flowchart TD\n  A --> B'])
  expect(mermaidBlocks('```python\nprint(1)\n```')).toEqual([])
  expect(titleOf(FLOW, 1)).toBe('Data flow')
  expect(titleOf('---\ntitle: Front matter\n---\nflowchart TD\n  A --> B', 2)).toBe('Front matter')
  expect(titleOf(SEQUENCE, 3)).toBe('sequenceDiagram #3')
})

test('numbers new blocks on and skips the ones it has', () => {
  const first = newDiagrams([], [FLOW, FLOW], 'dark')
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ id: 1, title: 'Data flow', status: 'rendering' })

  const second = newDiagrams(first, [FLOW, SEQUENCE], 'dark')
  expect(second.map(one => one.id)).toEqual([2])
  // Another theme is another render.
  expect(newDiagrams([], [FLOW], 'default')[0]?.hash).not.toBe(first[0]?.hash)
})

test('reads the PNG size and fits it to the pane', () => {
  expect(pngSize(PNG)).toEqual({ width: 1568, height: 220 })
  // Wide: as wide as the pane allows, few rows.
  expect(fit(1568, 220, 60, 40)).toEqual({ columns: 60, rows: 4 })
  // Tall: held to the rows, narrowed to keep the aspect.
  expect(fit(530, 1488, 60, 20)).toEqual({ columns: 14, rows: 20 })
})

test('keeps the parse error and drops the stack', () => {
  const stderr = [
    '',
    'Error: Parse error on line 2:',
    '--^',
    "Expecting 'NODE_STRING', got 'EOF'",
    'Parser.parseError (https://mermaid-cli-intercept.invalid/chunk.mjs:1:1)',
    '    at async renderMermaid (file:///index.js:690:22)',
  ].join('\n')
  expect(errorOf(stderr)).toBe("Error: Parse error on line 2:\n--^\nExpecting 'NODE_STRING', got 'EOF'")
})

test('the pane says so while it has no diagram', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No diagrams yet/ })).toBeDefined()
  await ui.unmount()
})

test('the pane shows the newest diagram and pages back', async ($, on) => {
  seed(on, RENDERED)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /#2 Broken/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Parse error/ })).toBeDefined()

  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /#1 Data flow/ })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('a surface without pictures shows the source', async ($, on) => {
  seed(on, RENDERED.slice(0, 1))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /flowchart TD/ })).toBeDefined()
  await ui.unmount()
})

test('the transcript draws a pointer in place of the block', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={(e.props as { text: string }).text} />
  })

  const ui = await $.ui.mount({
    plugin: 'sidemaid',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    surface: 'terminal',
    props: { text: REPLY, isFirstOfReply: true },
  })
  const drawn = await ui.find({ type: 'Markdown' })
  expect(drawn?.text).toContain('◧ *Mermaid diagram, in the pane (/mermaid)*')
  expect(drawn?.text).not.toContain('flowchart TD')
  await ui.unmount()
})
