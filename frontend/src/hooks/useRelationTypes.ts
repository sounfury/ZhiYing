import { useEffect, useState } from 'react'
import { getRelationTypes, type RelationTypeMeta, type GraphData } from '../api'

/** 随书籍和分析结果刷新注册表；没有本地固定类型副本。 */
export function useRelationTypes(bookId: string, graph: GraphData | null) {
  const [types, setTypes] = useState<RelationTypeMeta[]>([])
  useEffect(() => {
    let cancelled = false
    setTypes([])
    if (bookId) void getRelationTypes(bookId).then((list) => {
      if (!cancelled) setTypes(list)
    }).catch(() => { /* 图上仍显示事实自带的标签 */ })
    return () => { cancelled = true }
  }, [bookId, graph])
  return types
}
