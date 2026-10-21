/** 回归验证图谱路径、文字避让与拓扑布局；直接转译项目 TypeScript，无需新增测试依赖。 */
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { routeEdges, nodeObstacles } = require('../src/components/GraphView/routing.ts')
const { curvePath } = require('../src/components/GraphView/curveGeometry.ts')
const { placeLabels } = require('../src/components/GraphView/labels.ts')
const { computeFocus, edgeStyle, nodeStyle } = require('../src/components/GraphView/style.ts')
const { boxAt, overlaps, pathHitsBox, pathPoint, sharedLength } = require('../src/components/GraphView/geometry.ts')
const { buildScene } = require('../src/components/GraphView/layout.ts')
const { Path } = require('@antv/g')

const node = (id, x, y, name = id, importance = 'supporting') => ({ id, personId: id, ghost: false, x, y, r: 20, slot: 0, center: false, node: { person_id: id, name, importance, appearance_count: 3, faction_ids: [], primary_faction_id: null } })
const edge = (a, b, hardness = 'hard') => ({ id: `e:${a}|${b}`, source: a, target: b, hardness, inFocus: false, controlPoints: [], path: [], labelText: '兄弟姐妹', edge: { person_a: a, person_b: b, tags: [{ directed: true, source_person_id: a, label: '保护', category: '硬关系', hardness, display_score: 1 }] } })
const scene = (nodes, edges) => {
  routeEdges(nodes, edges)
  return { nodes, edges, twins: [], combos: [], rings: [], focusSingle: false, dense: nodes.length > 40 || edges.length > 70 }
}
const palette = { canvas: '#fff', ink: '#222', ink2: '#555', warn: '#c54', hard: '#222', medium: '#555', soft: '#999', serif: 'serif', sans: 'sans-serif', faction: ['#444'], factionSoft: ['#eee'] }
const context = (extra = {}) => ({ palette, zoom: 1, hoverNode: null, hoverEdge: null, selectedNode: null, selectedEdge: null, ...extra })
function assertClearLabels(sc, ctx) {
  const focus = computeFocus(sc, ctx), labels = placeLabels(sc, ctx, focus)
  const occupied = sc.nodes.map((n) => boxAt(n, n.r * 2 + 6, n.r * 2 + 6))
  for (const [id, name] of labels.names) if (name.visible) {
    assert.ok(!occupied.some((b) => overlaps(b, name.box)), `人物姓名碰撞: ${id}`)
    // 四周都有线的人物（星形中心）允许姓名压在线最少的一侧，其余姓名必须完全避开连线。
    if (!name.overEdges) assert.ok(!sc.edges.some((e) => pathHitsBox(e.path, name.box)), `连线穿过姓名: ${id}`)
    occupied.push(name.box)
  }
  for (const [id, label] of labels.edges) if (label.visible) {
    assert.ok(!occupied.some((b) => overlaps(b, label.box)), `关系文字碰撞: ${id}`)
    assert.ok(!sc.edges.some((e) => e.id !== id && pathHitsBox(e.path, label.box)), `其他连线穿过关系文字: ${id}`)
    occupied.push(label.box)
  }
  return { labels, focus }
}

test('共线长关系绕开沿途人物，并拆开反向关系通道', () => {
  const sc = scene([node('a', 0, 0), node('b', 160, 0), node('c', 320, 0), node('d', 480, 0)], [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'd'), edge('d', 'a')])
  const obstacles = nodeObstacles(sc.nodes)
  for (const e of sc.edges) {
    assert.ok(e.path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
    for (const o of obstacles) if (!o.name && o.owner !== e.source && o.owner !== e.target) assert.ok(!pathHitsBox(e.path, o.box), `${e.id} 穿过 ${o.owner}`)
  }
  const long = sc.edges.find((e) => e.id === 'e:a|d'), reverse = sc.edges.find((e) => e.id === 'e:d|a')
  assert.ok(long.controlPoints.length > 0)
  let shared = 0
  for (let i = 1; i < long.path.length; i++) for (let j = 1; j < reverse.path.length; j++) shared += sharedLength(long.path[i - 1], long.path[i], reverse.path[j - 1], reverse.path[j])
  assert.ok(shared < 20, `反向边仍共线 ${shared}`)
  const old = JSON.stringify(sc.edges.map((e) => e.path))
  routeEdges(sc.nodes, sc.edges)
  assert.equal(JSON.stringify(sc.edges.map((e) => e.path)), old)
})

test('复杂障碍通过可见角点绕行，曲线采样与 G6 一致', () => {
  const nodes = [node('a', 0, 0), node('b', 600, 0)]
  for (let i = 0; i < 7; i++) nodes.push(node(`obstacle${i}`, 300, (i - 3) * 60))
  const sc = scene(nodes, [edge('a', 'b')]), e = sc.edges[0]
  for (const o of nodeObstacles(nodes)) if (!o.name && o.owner !== 'a' && o.owner !== 'b') assert.ok(!pathHitsBox(e.path, o.box))
  const vertices = [e.path[0], ...e.controlPoints, e.path[e.path.length - 1]]
  const path = new Path({ style: { d: curvePath(vertices) } })
  for (const ratio of [0.2, 0.38, 0.5, 0.62, 0.8]) {
    const actual = path.getPoint(ratio), predicted = pathPoint(e.path, ratio)
    assert.ok(Math.hypot(actual.x - predicted.x, actual.y - predicted.y) < 2, '文字避让坐标与绘制路径不一致')
  }
  path.destroy()
})

test('星形中心的连线保持直线，姓名让线而不是线绕姓名', () => {
  // 姓名默认在人物下方：从下方连入的线、中心向下连出的线都不应为此绕弯。
  const nodes = [node('hub', 0, 0, '斯蒂芬', 'main')]
  const edges = []
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6 + 0.1
    nodes.push(node(`p${i}`, Math.cos(angle) * 260, Math.sin(angle) * 260, `人物${i}`))
    edges.push(edge('hub', `p${i}`, i % 3 ? 'soft' : 'hard'))
  }
  const sc = scene(nodes, edges)
  for (const e of sc.edges) assert.equal(e.controlPoints.length, 0, `${e.id} 无遮挡却被弯曲`)
  const { labels } = assertClearLabels(sc, context())
  for (const [id, name] of labels.names) assert.ok(name.visible, `姓名被隐藏: ${id}`)
})

test('姓名和关系标签在默认、悬停、选中及缩放下统一避让', () => {
  const nodes = [node('hub', 0, 0, '斯蒂芬', 'main')]
  const edges = []
  for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8
    nodes.push(node(`p${i}`, Math.cos(angle) * 220, Math.sin(angle) * 220, `人物·很长的姓名${i}`))
    edges.push(edge('hub', `p${i}`, i % 2 ? 'soft' : 'medium'))
  }
  const sc = scene(nodes, edges)
  for (const zoom of [0.4, 0.7, 1, 1.5]) for (const extra of [{}, { hoverNode: 'hub' }, { selectedNode: 'hub' }, { selectedEdge: edges[0].id }, { hoverEdge: edges[0].id }]) assertClearLabels(sc, context({ zoom, ...extra }))
})

test('独立选中保留箭头，拖动后重新避让新位置', () => {
  const sc = scene([node('a', 0, 0), node('b', 360, 0), node('c', 180, 160)], [edge('a', 'b'), edge('b', 'a')])
  const ctx = context({ selectedEdge: sc.edges[1].id })
  const { labels, focus } = assertClearLabels(sc, ctx)
  const styles = sc.edges.map((e) => edgeStyle(e, sc, ctx, focus, labels))
  assert.ok(styles.every((s) => s.endArrow && !s.startArrow))
  assert.equal(styles[0].stroke, palette.hard)
  assert.equal(styles[1].stroke, palette.warn)
  assert.equal(nodeStyle(sc.nodes[0], ctx, focus, labels).label, labels.names.get('a').visible)
  const old = JSON.stringify(sc.edges.map((e) => e.path))
  sc.nodes[2].y = 0
  routeEdges(sc.nodes, sc.edges)
  assert.notEqual(JSON.stringify(sc.edges.map((e) => e.path)), old)
  assertClearLabels(sc, ctx)
})

test('百人分区图保持有限路径与交互避让', () => {
  const nodes = [], edges = [], factions = []
  for (let group = 0; group < 5; group++) {
    const member_ids = []
    for (let i = 0; i < 20; i++) {
      const id = `g${group}p${i}`
      member_ids.push(id)
      nodes.push({ ...node(id, 0, 0, `人物姓名${group}·${i}`, i === 0 ? 'main' : 'supporting').node, primary_faction_id: `g${group}` })
      if (i > 0) edges.push(edge(`g${group}p0`, id, i % 3 === 0 ? 'hard' : 'medium').edge)
      if (i > 1 && i % 2 === 0) edges.push(edge(`g${group}p${i - 1}`, id, 'soft').edge)
    }
    factions.push({ faction_id: `g${group}`, name: `势力${group}`, order: group, member_ids, all_member_ids: member_ids })
    if (group > 0) edges.push(edge(`g${group - 1}p3`, `g${group}p3`).edge)
  }
  const start = performance.now()
  const sc = buildScene({ slice: { nodes, edges }, factions, centerId: 'g0p0', egoId: null, useFactionLayout: true, focusSingle: false })
  const built = performance.now() - start
  assert.ok(sc.edges.every((e) => e.path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))))
  const interactions = performance.now()
  assertClearLabels(sc, context({ hoverNode: 'g0p0', zoom: 0.75 }))
  console.log(`百人图 ${edges.length} 条关系：编排 ${built.toFixed(0)}ms，悬停文字 ${ (performance.now() - interactions).toFixed(0)}ms`)
})

test('多势力主角 / 配角在有关系的势力里生成分身，挂名势力与龙套不生成', () => {
  const person = (id, importance, primary, faction_ids) => ({ ...node(id, 0, 0, id, importance).node, primary_faction_id: primary, faction_ids })
  const nodes = [
    person('甲', 'main', 'school', ['school', 'family', 'club']),
    person('同学', 'supporting', 'school', ['school']),
    person('龙套', 'minor', 'school', ['school', 'family']),
    person('兄', 'supporting', 'family', ['family']),
    person('妹', 'supporting', 'family', ['family']),
    person('社员', 'supporting', 'club', ['club']),
  ]
  const edges = [edge('甲', '同学').edge, edge('甲', '兄').edge, edge('妹', '甲').edge, edge('龙套', '兄').edge, edge('兄', '妹').edge]
  const faction = (faction_id, order, member_ids, all_member_ids) => ({ faction_id, name: faction_id, order, member_ids, all_member_ids })
  const factions = [
    faction('school', 0, ['甲', '同学', '龙套'], ['甲', '同学', '龙套']),
    faction('family', 1, ['兄', '妹'], ['兄', '妹', '甲', '龙套']),
    faction('club', 2, ['社员'], ['社员', '甲']),
  ]
  const build = (egoId) => buildScene({ slice: { nodes, edges }, factions, centerId: '甲', egoId, useFactionLayout: true, focusSingle: false })
  const sc = build(null)
  // 甲在家族有关系 → 分身；在社团只是挂名 → 无；龙套两边都有关系也不分身。
  assert.deepEqual(sc.nodes.filter((n) => n.ghost).map((n) => n.id), ['甲@family'])
  const twin = sc.nodes.find((n) => n.ghost)
  assert.equal(twin.personId, '甲')
  assert.equal(twin.node.person_id, '甲')
  assert.equal(twin.combo, 'family')
  assert.equal(sc.nodes.find((n) => n.id === '甲').combo, 'school')
  assert.ok(twin.r < sc.nodes.find((n) => n.id === '甲').r)
  const ends = Object.fromEntries(sc.edges.map((e) => [e.id, [e.source, e.target]]))
  assert.deepEqual(ends['e:甲|同学'], ['甲', '同学'])
  assert.deepEqual(ends['e:甲|兄'], ['甲@family', '兄'])
  assert.deepEqual(ends['e:妹|甲'], ['妹', '甲@family'])
  assert.deepEqual(ends['e:龙套|兄'], ['龙套', '兄'])
  assert.deepEqual(sc.twins, [{ id: 'twin:甲@family', personId: '甲', source: '甲', target: '甲@family' }])
  // 悬停分身或选中人物：本体、分身及两边的关系一起高亮，提示线只在此时可见。
  const hover = computeFocus(sc, context({ hoverNode: '甲@family' }))
  assert.deepEqual([...hover.nodes].sort(), ['兄', '妹', '同学', '甲', '甲@family'].sort())
  assert.equal(hover.edges.size, 3)
  assert.equal(hover.person, '甲')
  assert.equal(computeFocus(sc, context()).person, null)
  const selected = context({ selectedNode: '甲' }), focus = computeFocus(sc, selected), labels = placeLabels(sc, selected, focus)
  assert.equal(focus.person, '甲')
  assert.equal(focus.selectedLabelEdges.size, 3)
  for (const id of ['甲', '甲@family']) assert.equal(nodeStyle(sc.nodes.find((n) => n.id === id), selected, focus, labels).stroke, palette.warn)
  assert.deepEqual(nodeStyle(twin, selected, focus, labels).lineDash, [4, 3])
  assertClearLabels(sc, context({ hoverNode: '甲' }))
  // 中心人物只出现一次；亲疏扇区没有势力块，也不分身。
  assert.equal(build('甲').nodes.filter((n) => n.ghost).length, 0)
  assert.equal(buildScene({ slice: { nodes, edges }, factions, centerId: '甲', egoId: null, useFactionLayout: false, focusSingle: false }).nodes.filter((n) => n.ghost).length, 0)
})

test('场景编排覆盖势力分区、亲疏布局、中心视图与空图', () => {
  const nodes = [node('a', 0, 0, '主角', 'main').node, node('b', 0, 0, '很长的配角姓名').node, node('c', 0, 0, '第三个人').node]
  const edges = [edge('a', 'b').edge, edge('b', 'c').edge, edge('a', 'c').edge]
  const factions = [{ faction_id: 'school', name: '学校', order: 0, member_ids: ['a', 'b', 'c'], all_member_ids: ['a', 'b', 'c'] }]
  for (const useFactionLayout of [true, false]) {
    const sc = buildScene({ slice: { nodes, edges }, factions, centerId: 'a', egoId: 'a', useFactionLayout, focusSingle: true })
    assert.equal(sc.nodes.find((n) => n.id === 'a').r, 32)
    assert.ok(sc.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)))
    assertClearLabels(sc, context({ hoverNode: 'a' }))
  }
  assert.equal(buildScene({ slice: { nodes: [], edges: [] }, factions: [], centerId: null, egoId: null, useFactionLayout: true, focusSingle: false }).nodes.length, 0)
})
