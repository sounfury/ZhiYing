import { useEffect, useRef, useState } from 'react'

interface MoreFiltersMenuProps {
  minAppearance: number
  onMinAppearanceChange: (v: number) => void
  includeSuppressed: boolean
  onIncludeSuppressedChange: (v: boolean) => void
}

/**
 * 不常动的两个过滤器收进弹层：min_appearance 多数人设一次就不再碰（默认 1），
 * 「显示被压制 soft」是排查压制边的小众开关。它们常驻在控制条里只会把行数撑开，
 * 把图挤矮。
 *
 * 弹层写法与 FactionFilter 一致（局部 open + wrapRef + document 上的 mousedown）。
 */
export function MoreFiltersMenu({
  minAppearance,
  onMinAppearanceChange,
  includeSuppressed,
  onIncludeSuppressedChange,
}: MoreFiltersMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点外面关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /** 摘要要能反映非默认状态，否则参数被调过了但从外面看不出来 */
  const badges: string[] = []
  if (minAppearance !== 1) badges.push(`min≥${minAppearance}`)
  if (includeSuppressed) badges.push('含压制')
  const summary = badges.length ? badges.join(' · ') : '默认'

  return (
    // 用 div 而非 label：label 会把点击代理到内部第一个可标注控件
    <div className="more-filters" ref={wrapRef}>
      <span className="more-filters-label">更多</span>
      <button
        type="button"
        className={`more-filters-btn${badges.length ? ' on' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="不常动的过滤器：出场章数下限、被压制关系的可见性"
      >
        <span>{summary}</span>
        <i aria-hidden>{open ? '▴' : '▾'}</i>
      </button>

      {open && (
        <div className="more-filters-pop">
          <label className="more-filters-row">
            min_appearance
            <input
              type="number"
              min={0}
              max={20}
              value={minAppearance}
              onChange={(e) => onMinAppearanceChange(Number(e.target.value) || 0)}
            />
          </label>

          <label className="more-filters-row check">
            <input
              type="checkbox"
              checked={includeSuppressed}
              onChange={(e) => onIncludeSuppressedChange(e.target.checked)}
            />
            显示被压制 soft
          </label>
        </div>
      )}
    </div>
  )
}
