export type Diagram = {
  id: number
  title: string
  source: string
  // Names the rendered files in the cache: the same source and theme render once.
  hash: string
  status: 'rendering' | 'ok' | 'error'
  png?: string
  width?: number
  height?: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mermaid-pane': {
      diagrams: Shaped<Diagram[]>
      // The diagram the person paged to; null follows the newest.
      selected: number | null
    }
  }
}
