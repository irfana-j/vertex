import { uid } from './id'
import type { FlowEdge, FlowNode, NodeData } from '../types'

// globalVariables/cloudService nodes are never hand-created here — they're
// always mirrored in from a Symphony template's real structure. The only
// node this app creates on its own is the Template Info overlay.
const DEFAULT_DATA: Record<string, () => NodeData> = {
  regressionInfo: () => ({
    label: 'Template Info',
    enabled: true,
    labels: ['Regression'],
  }),
}

export function createNode(type: string, existingCount = 0): FlowNode {
  const col = existingCount % 4
  const row = Math.floor(existingCount / 4)
  return {
    id: uid('node'),
    type,
    position: { x: 80 + col * 230, y: 110 + row * 170 },
    data: DEFAULT_DATA[type] ? DEFAULT_DATA[type]() : { label: type },
  }
}

export function createEdge(sourceId: string, targetId: string): FlowEdge {
  return {
    id: uid('edge'),
    source: sourceId,
    target: targetId,
    type: 'smoothstep',
    animated: false,
  }
}
