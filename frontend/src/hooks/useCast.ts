import { useCallback, useEffect, useState } from 'react'
import {
  getCast,
  mergeCastPersons,
  putCast,
  type Cast,
  type CastPerson,
} from '../api'

/**
 * 人名册：随 bookId 加载；保存单人（PUT 按 id 合并）；合并两人。
 */
export function useCast(bookId: string) {
  const [cast, setCast] = useState<Cast | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!bookId) {
      setCast(null)
      setError('')
      return
    }
    setLoading(true)
    setError('')
    try {
      setCast(await getCast(bookId))
    } catch (e) {
      setCast(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [bookId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const savePerson = useCallback(
    async (person: CastPerson) => {
      if (!bookId || !cast) return
      setSaving(true)
      setError('')
      try {
        const next = await putCast(bookId, {
          version: cast.version,
          persons: [person],
        })
        setCast(next)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      } finally {
        setSaving(false)
      }
    },
    [bookId, cast],
  )

  const merge = useCallback(
    async (keepId: string, dropId: string) => {
      if (!bookId) return
      setSaving(true)
      setError('')
      try {
        const next = await mergeCastPersons(bookId, keepId, dropId)
        setCast(next)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      } finally {
        setSaving(false)
      }
    },
    [bookId],
  )

  return { cast, loading, saving, error, refresh, savePerson, merge }
}
