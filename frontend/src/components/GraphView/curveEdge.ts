/** G6 自定义平滑关系边：沿避障路由绘制连续贝塞尔曲线，并沿用箭头、标签与点击命中。 */
import { BaseEdge, ExtensionCategory, register, type BaseEdgeStyleProps } from '@antv/g6'
import { curvePath } from './curveGeometry'

type CurveStyle = Required<BaseEdgeStyleProps> & { controlPoints?: [number, number][] }

class RoutedCurve extends BaseEdge {
  protected getKeyPath(attributes: CurveStyle) {
    const controls = attributes.controlPoints ?? []
    const [source, target] = this.getEndpoints(attributes, true, controls)
    return curvePath([source, ...controls, target].map(([x, y]) => ({ x, y })))
  }
}

register(ExtensionCategory.EDGE, 'routed-curve', RoutedCurve)
