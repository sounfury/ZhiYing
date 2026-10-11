/** 从连线的可见关系标签推导相对两端的箭头与方向符号，供画布、悬停卡和详情共用。 */
import type { GraphEdge } from './api'

export function edgeDirection(edge: GraphEdge) {
  const startArrow = edge.tags.some((tag) => tag.directed && tag.source_person_id === edge.person_b)
  const endArrow = edge.tags.some((tag) => tag.directed && tag.source_person_id === edge.person_a)
  return {
    startArrow,
    endArrow,
    symbol: startArrow && endArrow ? '↔' : endArrow ? '→' : startArrow ? '←' : '—',
  }
}
