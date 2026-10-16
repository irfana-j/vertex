import type { FlowNode } from '../types'

interface LayoutOptions {
  cols?: number
  colWidth?: number
  rowHeight?: number
  originX?: number
  originY?: number
}

// Auto-arranges an arbitrary number of nodes in a grid so a template with
// 40 scenario nodes lays out sensibly without hand-authored coordinates.
export function autoLayout(nodes: FlowNode[], options: LayoutOptions = {}): FlowNode[] {
  const { cols = 5, colWidth = 210, rowHeight = 150, originX = 60, originY = 80 } = options
  return nodes.map((n, i) => ({
    ...n,
    position: { x: originX + (i % cols) * colWidth, y: originY + Math.floor(i / cols) * rowHeight },
  }))
}
