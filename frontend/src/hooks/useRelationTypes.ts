import { useEffect, useState } from 'react'
import {
  FALLBACK_RELATION_TYPES,
  getRelationTypes,
  type RelationTypeMeta,
} from '../api'

/**
 * 关系类型枚举（GET /api/meta/relation-types）。
 * 失败时退回与后端 SSOT 对齐的本地副本，筛选器仍可用。
 */
export function useRelationTypes() {
  const [types, setTypes] = useState<RelationTypeMeta[]>(FALLBACK_RELATION_TYPES)

  useEffect(() => {
    let cancelled = false
    void getRelationTypes()
      .then((list) => {
        if (!cancelled && list.length) setTypes(list)
      })
      .catch(() => {
        /* keep fallback */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return types
}
