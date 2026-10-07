/** 书的简易封面：按书名稳定取一组深色渐变，书架与空态共用。 */

/** 简易封面底色：按书名稳定取一组渐变 */
const COVERS = [
  ['#3b6b56', '#1f3b30'],
  ['#8a5a3c', '#4d2e1c'],
  ['#4f5fa8', '#2a3366'],
  ['#7a4f6d', '#43293b'],
  ['#5d7a3a', '#33451f'],
  ['#9a6b2f', '#55391a'],
]

export function coverGradient(title: string): string {
  let h = 0
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const [a, b] = COVERS[h % COVERS.length]
  return `linear-gradient(160deg, ${a}, ${b})`
}
