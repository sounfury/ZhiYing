/** EPUB 上传拖放区：拖入或点击选择 .epub 文件，交给上层上传；书架抽屉与空态共用。 */
import { useRef, useState, type DragEvent } from 'react'

interface EpubDropZoneProps {
  onUpload: (file: File | null) => Promise<void> | void
  className?: string
}

export function EpubDropZone({ onUpload, className = '' }: EpubDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const send = async (file: File | undefined) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.epub')) {
      setHint(`「${file.name}」不是 EPUB 文件`)
      return
    }
    setHint('')
    setBusy(true)
    try {
      await onUpload(file)
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setOver(false)
    if (!busy) void send(e.dataTransfer.files?.[0])
  }

  return (
    <div
      className={`drop${over ? ' over' : ''}${busy ? ' busy' : ''} ${className}`.trim()}
      role="button"
      tabIndex={0}
      aria-label="上传 EPUB"
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <b>{busy ? '正在上传…' : '把 EPUB 拖到这里'}</b>
      或 <u>选择文件</u> · 导入后自动识别正文章节
      {hint && <span className="drop-hint">{hint}</span>}
      <input
        ref={inputRef}
        type="file"
        accept=".epub"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          void send(file)
        }}
      />
    </div>
  )
}
