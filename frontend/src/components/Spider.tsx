/**
 * 看板小蜘蛛（手绘毛团款）：吊在丝上逐帧晃、眨眼、线条抖动。分析等待动画与图区常驻蜘蛛共用。
 * look 让瞳孔朝某个方向看（单位向量），asleep 时闭眼打盹；纯装饰，对读屏隐藏。
 */
import { useId } from 'react'
import './spider.css'

/** 毛团身体轮廓（预先算好的锯齿圆） */
const BODY =
  'M82.2,60L78.9,62.5L81.7,65.7L77.6,67.2L79.7,71.4L73.4,70.4L74.1,74.7L70.8,75.2L69.3,78.2L65.1,75.7L63.5,81.8L60,77L56.6,81.4L54.7,76.3L50.3,79.2L50.3,73.6L44.7,75.9L44.8,71.8L40.6,71.2L42.1,67.4L37.4,66L42.5,62.3L36.2,60L40.9,57.5L38.5,54.3L44,53.4L39.7,48.3L45.7,48.9L44.5,43.9L49.1,44.8L50.2,40.6L54.3,42.5L56.8,39.8L60,42.1L63.2,39.7L65.7,42.5L70,40.2L69.6,46.5L74.3,45.1L73.7,49.3L80.5,48.1L77.1,53L82.4,54.1L78.2,57.6Z'
/** 八条腿：关节点 + 后两段折线；左右各四条，相邻腿交替摆 */
const LEGS: [number, number, string][] = [
  [42, 54, '24,34 14,44'],
  [40, 62, '18,56 8,70'],
  [42, 70, '22,80 16,98'],
  [48, 76, '36,94 38,110'],
  [78, 54, '96,34 106,44'],
  [80, 62, '102,56 112,70'],
  [78, 70, '98,80 104,98'],
  [72, 76, '84,94 82,110'],
]
/** 瞳孔最多偏离眼心的距离 */
const GAZE = 2

interface Props {
  className?: string
  look?: { x: number; y: number } | null
  asleep?: boolean
}

export function Spider({ className, look, asleep }: Props) {
  const filterId = `spider-boil-${useId().replace(/[^\w-]/g, '')}`
  const dx = (look?.x ?? 0) * GAZE
  const dy = (look?.y ?? 0) * GAZE
  return (
    <svg className={`spider${asleep ? ' asleep' : ''} ${className ?? ''}`} viewBox="0 0 120 120" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs>
        {/* 噪声种子逐帧切换，墨线像手绘逐帧那样抖 */}
        <filter id={filterId} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves={2} seed="1">
            <animate attributeName="seed" values="1;2;3" dur="0.3s" repeatCount="indefinite" calcMode="discrete" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" scale="3.5" />
        </filter>
      </defs>
      <g className="spider-boil" filter={`url(#${filterId})`}>
        <line className="spider-silk" x1="60" y1="0" x2="60" y2="42" />
        <g className="spider-dangle">
          {LEGS.map(([x, y, rest], i) => (
            <path key={i} className={`spider-leg${(i + (i >> 2)) % 2 ? ' alt' : ''}`} style={{ transformOrigin: `${x}px ${y}px` }} d={`M${x},${y} L${rest}`} />
          ))}
          <path className="spider-ink" d={BODY} />
          <g className="spider-eyes">
            <ellipse cx="53" cy="54" rx="5" ry="6" />
            <ellipse cx="68" cy="53" rx="6.5" ry="7.5" />
          </g>
          <g className="spider-pupils" style={{ transform: `translate(${dx}px, ${dy}px)` }}>
            <circle className="spider-ink" cx="54.5" cy="56" r="1.8" />
            <circle className="spider-ink" cx="66" cy="51" r="2.2" />
          </g>
          <path className="spider-fang" d="M48,64 Q60,74 73,63 L70,66 L68,63 L66,67 L63,64 L61,68 L58,64 L56,67 L54,64 L52,66 L50,63Z" />
        </g>
      </g>
    </svg>
  )
}
