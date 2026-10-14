/** 独立节点细化回归：直接转译纯 TS，验证拓扑、名字足迹、分组边界与确定性。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/graphPlacement.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const loaded = { exports: {} }
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded)
const { refinePlacement } = loaded.exports

const node = (id, nameWidth = 48, radius = 20) => ({ id, radius, nameWidth, nameHeight: 15 })
const edge = (a, b) => ({ person_a: a, person_b: b })
const groups = (nodes, id = 'faction') => new Map(nodes.map((n) => [n.id, id]))
const serial = (pos) => [...pos].sort(([a], [b]) => a.localeCompare(b))
const distance = (pos, e) => Math.hypot(pos.get(e.person_a).x - pos.get(e.person_b).x, pos.get(e.person_a).y - pos.get(e.person_b).y)

function boxes(n, pos) {
  const p = pos.get(n.id)
  return [
    [p.x - n.radius - 2, p.y - n.radius - 2, p.x + n.radius + 2, p.y + n.radius + 2],
    [p.x - n.nameWidth / 2 - 3, p.y + n.radius + 3, p.x + n.nameWidth / 2 + 3, p.y + n.radius + 6 + n.nameHeight],
  ]
}
function collisions(nodes, pos) {
  let count = 0
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (boxes(nodes[i], pos).some((a) => boxes(nodes[j], pos).some((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]))) count++
  }
  return count
}
function crossings(edges, pos) {
  const side = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  let count = 0
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i]
    const b = edges[j]
    if ([a.person_a, a.person_b].some((id) => id === b.person_a || id === b.person_b)) continue
    const p = pos.get(a.person_a)
    const q = pos.get(a.person_b)
    const r = pos.get(b.person_a)
    const s = pos.get(b.person_b)
    if (side(p, q, r) * side(p, q, s) < -1e-6 && side(r, s, p) * side(r, s, q) < -1e-6) count++
  }
  return count
}
// 独立采样直线内部，检查无关节点 / 名字被穿过；不复刻被测的 slab 求交。
function blockers(nodes, edges, pos) {
  let count = 0
  for (const e of edges) for (const n of nodes) {
    if (n.id === e.person_a || n.id === e.person_b) continue
    const a = pos.get(e.person_a)
    const b = pos.get(e.person_b)
    if (boxes(n, pos).some((box) => {
      for (let i = 1; i < 400; i++) {
        const x = a.x + (b.x - a.x) * i / 400
        const y = a.y + (b.y - a.y) * i / 400
        if (x > box[0] && x < box[2] && y > box[1] && y < box[3]) return true
      }
      return false
    })) count++
  }
  return count
}
function run(input) {
  const before = serial(input.positions).map(([id, p]) => [id, { ...p }])
  const output = refinePlacement(input)
  assert.deepEqual(serial(input.positions), before, 'input positions remain unchanged')
  assert.deepEqual(serial(refinePlacement(input)), serial(output), 'repeat calls are deterministic')
  assert.deepEqual(serial(refinePlacement({
    ...input,
    nodes: [...input.nodes].reverse(),
    edges: [...input.edges].reverse().map((e) => edge(e.person_b, e.person_a)),
    positions: new Map([...input.positions].reverse()),
    groups: new Map([...input.groups].reverse()),
  })), serial(output), 'input ordering and edge direction do not affect coordinates')
  for (const [id, p] of output) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), `${id} is finite`)
    assert.notStrictEqual(p, input.positions.get(id), `${id} does not share a mutable point`)
  }
  if (input.fixedCenter) assert.deepEqual(output.get(input.fixedCenter), input.positions.get(input.fixedCenter))
  return output
}

const peers = 'abcdef'.split('')
const starNodes = [node('hub', 60, 27), ...peers.map((id) => node(id))]
const starPos = new Map([['hub', { x: 20, y: -10 }], ...peers.map((id, i) => [id, {
  x: 20 + 180 * Math.cos(i * Math.PI / 3), y: -10 + 180 * Math.sin(i * Math.PI / 3),
}])])
const peerEdges = [edge('a', 'd'), edge('b', 'e'), edge('c', 'f')]
const starEdges = [...peers.map((id) => edge('hub', id)), ...peerEdges]
const star = run({ positions: starPos, nodes: starNodes, edges: starEdges, groups: groups(starNodes), fixedCenter: 'hub' })
assert(crossings(starEdges, star) < crossings(starEdges, starPos), 'tangled star loses crossings')
assert(blockers(starNodes, starEdges, star) < blockers(starNodes, starEdges, starPos), 'peer lines stop passing through the hub')
assert(peerEdges.reduce((s, e) => s + distance(star, e), 0) < peerEdges.reduce((s, e) => s + distance(starPos, e), 0) * 0.7, 'linked peers move substantially closer')
assert.equal(collisions(starNodes, star), 0)

const triangleNodes = ['a', 'b', 'c'].map((id) => node(id))
const trianglePos = new Map([['a', { x: -120, y: 0 }], ['b', { x: 0, y: 0 }], ['c', { x: 120, y: 0 }]])
const triangleEdges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')]
const triangle = run({ positions: trianglePos, nodes: triangleNodes, edges: triangleEdges, groups: groups(triangleNodes), fixedCenter: 'b' })
const ta = triangle.get('a')
const tb = triangle.get('b')
const tc = triangle.get('c')
assert(Math.abs((ta.x - tb.x) * (tc.y - tb.y) - (ta.y - tb.y) * (tc.x - tb.x)) > 100, 'aligned triangle unfolds')
assert.equal(blockers(triangleNodes, triangleEdges, triangle), 0)
assert.equal(collisions(triangleNodes, triangle), 0)

const longNodes = Array.from({ length: 12 }, (_, i) => node(`name-${i.toString().padStart(2, '0')}`, 320 + i * 20))
const longPos = new Map(longNodes.map((n, i) => [n.id, { x: (i % 4) * 60, y: Math.floor(i / 4) * 50 }]))
const longNames = run({ positions: longPos, nodes: longNodes, edges: [], groups: groups(longNodes), fixedCenter: longNodes[0].id })
assert(collisions(longNodes, longPos) > 0)
assert.equal(collisions(longNodes, longNames), 0, 'long name / name and name / node overlaps are removed')

const coincidentPos = new Map(longNodes.map((n) => [n.id, { x: 0, y: 0 }]))
const coincident = run({ positions: coincidentPos, nodes: longNodes, edges: [], groups: groups(longNodes), fixedCenter: longNodes[0].id })
assert.equal(collisions(longNodes, coincident), 0, 'coincident long names separate without random jitter')

const sectorNodes = Array.from({ length: 8 }, (_, i) => node(`sector-${i}`, 65))
const sectorPos = new Map(sectorNodes.map((n, i) => {
  const angle = (i < 4 ? 2.8 : -0.35) + (i % 4) * 0.2
  return [n.id, { x: 240 * Math.cos(angle), y: 240 * Math.sin(angle) }]
}))
const sectorGroups = new Map(sectorNodes.map((n, i) => [n.id, i < 4 ? 'hard/faction-a' : 'soft/faction-b']))
const sectorBounds = new Map(sectorNodes.map((n, i) => [n.id, {
  origin: { x: 0, y: 0 }, minRadius: 220, maxRadius: 320,
  minAngle: i < 4 ? 2.7 : -0.45, maxAngle: i < 4 ? 3.5 : 0.45,
}]))
const sectorEdges = [edge('sector-0', 'sector-3'), edge('sector-4', 'sector-7'), edge('sector-0', 'sector-4')]
const sectors = run({ positions: sectorPos, nodes: sectorNodes, edges: sectorEdges, groups: sectorGroups, bounds: sectorBounds })
for (const n of sectorNodes) {
  const p = sectors.get(n.id)
  const b = sectorBounds.get(n.id)
  const mid = (b.minAngle + b.maxAngle) / 2
  const raw = Math.atan2(p.y, p.x)
  const angle = raw + Math.round((mid - raw) / (Math.PI * 2)) * Math.PI * 2
  assert(angle >= b.minAngle - 1e-6 && angle <= b.maxAngle + 1e-6, 'group stays inside its assigned wedge')
  assert(Math.hypot(p.x, p.y) >= b.minRadius - 1e-6 && Math.hypot(p.x, p.y) <= b.maxRadius + 1e-6, 'radial tier is preserved')
}
assert.equal(collisions(sectorNodes, sectors), 0)

const arcNodes = [node('arc-a'), node('arc-b')]
const arcPos = new Map(arcNodes.map((n) => [n.id, { x: 0, y: 240 }]))
const arcBounds = new Map(arcNodes.map((n) => [n.id, {
  origin: { x: 0, y: 0 }, minRadius: 240, maxRadius: 240, minAngle: 1, maxAngle: 2,
}]))
const arc = run({ positions: arcPos, nodes: arcNodes, edges: [], groups: groups(arcNodes), bounds: arcBounds })
assert.equal(collisions(arcNodes, arc), 0, 'coincident nodes can move tangentially on a fixed-radius arc')
for (const p of arc.values()) assert(Math.abs(Math.hypot(p.x, p.y) - 240) < 1e-6)

// 代表性大图也执行全部有限性 / 确定性检查；不使用依赖机器速度的计时断言。
const largeNodes = Array.from({ length: 100 }, (_, i) => node(`large-${i.toString().padStart(3, '0')}`, 65))
const largePos = new Map(largeNodes.map((n, i) => [n.id, {
  x: 550 * Math.cos(i * Math.PI / 50), y: 550 * Math.sin(i * Math.PI / 50),
}]))
const largeEdges = largeNodes.flatMap((n, i) => [edge(n.id, largeNodes[(i + 17) % 100].id), edge(n.id, largeNodes[(i + 31) % 100].id)])
const large = run({ positions: largePos, nodes: largeNodes, edges: largeEdges, groups: groups(largeNodes) })
assert.equal(collisions(largeNodes, large), 0)

assert.equal(refinePlacement({ positions: new Map(), nodes: [], edges: [], groups: new Map() }).size, 0)
const singleton = [node('solo')]
assert.deepEqual(serial(run({ positions: new Map([['solo', { x: 42, y: -9 }]]), nodes: singleton, edges: [], groups: groups(singleton) })), [['solo', { x: 42, y: -9 }]])
console.log(JSON.stringify({
  star: { crossings: [crossings(starEdges, starPos), crossings(starEdges, star)], blockers: [blockers(starNodes, starEdges, starPos), blockers(starNodes, starEdges, star)], peerLength: [peerEdges.reduce((s, e) => s + distance(starPos, e), 0), peerEdges.reduce((s, e) => s + distance(star, e), 0)], coordinates: serial(star) },
  triangle: { blockers: [blockers(triangleNodes, triangleEdges, trianglePos), blockers(triangleNodes, triangleEdges, triangle)], coordinates: serial(triangle) },
  longNames: { collisions: [collisions(longNodes, longPos), collisions(longNodes, longNames)] },
  sectors: { collisions: collisions(sectorNodes, sectors) },
  checks: 'topology, footprints, fixed center, sectors, fixed-radius arc, coincident points, 100 nodes / 200 edges, empty/singleton, immutable input, deterministic input permutations',
}, null, 2))
