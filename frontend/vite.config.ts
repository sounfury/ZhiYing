/** 前端开发与构建配置：代理后端，仅在开发服务器接收本机图谱性能记录，并让依赖体积适配 pi web 预览代理。 */
import { appendFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** 记录留在忽略提交的 .vite 目录，便于读取用户实际 Chrome 的采样。 */
function graphPerfLog(): Plugin {
  const directory = fileURLToPath(new URL('./.vite/', import.meta.url))
  return {
    name: 'graph-perf-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__zy_perf', (req, res, next) => {
        if (req.method !== 'POST') return next()
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
          res.writeHead(403).end()
          return
        }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 65536) req.destroy()
        })
        req.on('end', () => {
          void (async () => {
            try {
              const report: unknown = JSON.parse(body)
              await mkdir(directory, { recursive: true })
              await appendFile(`${directory}/graph-perf.log`, `${JSON.stringify({ receivedAt: new Date().toISOString(), report })}\n`)
              res.writeHead(204).end()
            } catch {
              res.writeHead(400).end()
            }
          })()
        })
      })
    },
  }
}

/**
 * 预打包依赖不内联 sourcemap：G6 内联后超过 11MB，pi web 预览代理对文本响应有 8MB 上限会回 502、页面白屏。
 * 依赖文件末尾仍保留指向外部 .map 的注释，调试不受影响。
 */
function depsWithoutInlineMap(): Plugin {
  return {
    name: 'deps-without-inline-map',
    apply: 'serve',
    transform(code, id) {
      if (id.includes('/node_modules/.vite/deps/')) return { code, map: { mappings: '' } }
    },
  }
}

export default defineConfig({
  plugins: [react(), graphPerfLog(), depsWithoutInlineMap()],
  server: {
    port: 5173,
    // 允许页面内 JS 采样（JS Self-Profiling），开发时 ?perf=1 用它定位卡顿；只作用于开发服务器
    headers: { 'Document-Policy': 'js-profiling' },
    proxy: {
      // 也接带部署前缀的 /preview/api/...（pi web 预览挂在子路径下），转发时去掉前缀
      '^(?:/[^/]+)?/api(?=/|$)': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^(?:\/[^/]+)?\/api/, '/api'),
      },
    },
  },
})
