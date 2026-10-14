/** 用整段贝塞尔曲线平滑避障控制点；渲染、避障和文字定位共用同一几何，路径不保留折线拐角。 */
import { distance, type Point } from './geometry'

type MoveCommand = ['M', number, number]
type CubicCommand = ['C', number, number, number, number, number, number]
export type CurvePath = [MoveCommand, ...CubicCommand[]]

export function curvePath(points: Point[]): CurvePath {
  const start = points[0], end = points[points.length - 1]
  const controls = points.slice(1, -1)
  const path: CurvePath = [['M', start.x, start.y]]
  // 相邻控制点的中点之间用二次曲线连接，连接处切线连续；曲线贴着控制折线各边的中点走，
  // 只在拐角处内切，不会像单段三次曲线那样整体塌向直线而重新撞上要绕开的人物。
  // 转为三次命令，统一 G6 绘制与几何采样。
  const quadratic = (a: Point, control: Point, b: Point) => path.push(['C',
    a.x + (control.x - a.x) * 2 / 3, a.y + (control.y - a.y) * 2 / 3,
    b.x + (control.x - b.x) * 2 / 3, b.y + (control.y - b.y) * 2 / 3,
    b.x, b.y,
  ])
  if (!controls.length) {
    quadratic(start, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, end)
    return path
  }
  let from = start
  controls.forEach((control, i) => {
    const next = controls[i + 1]
    const to = next ? { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 } : end
    quadratic(from, control, to)
    from = to
  })
  return path
}

export function sampleCurve(points: Point[]): Point[] {
  const commands = curvePath(points)
  const sampled = [points[0]]
  let from = points[0]
  for (let i = 1; i < commands.length; i++) {
    const c = commands[i] as CubicCommand
    const control1 = { x: c[1], y: c[2] }, control2 = { x: c[3], y: c[4] }, to = { x: c[5], y: c[6] }
    const polygonLength = distance(from, control1) + distance(control1, control2) + distance(control2, to)
    const steps = Math.max(16, Math.min(160, Math.ceil(polygonLength / 8)))
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, u = 1 - t
      sampled.push({ x: u ** 3 * from.x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t ** 3 * c[5], y: u ** 3 * from.y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t ** 3 * c[6] })
    }
    from = to
  }
  return sampled
}
