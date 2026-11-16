import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

const THEMES_DIR = path.resolve(__dirname, 'src/themes')
// data-theme values served by each theme folder: Dark and Based run the same UI; Based only swaps tokens (styles/based.css)
const THEME_IDS = { place: ['dark', 'based'] }

function inlineCss() {
  return {
    name: 'inline-css-plugin',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx || !ctx.bundle) return html;
        const tags = [];
        for (const [fileName, file] of Object.entries(ctx.bundle)) {
          if (fileName.endsWith('.css') && file.type === 'asset' && file.source) {
            tags.push({
              tag: 'style',
              attrs: { 'data-inlined-css': fileName },
              children: typeof file.source === 'string' ? file.source : file.source.toString(),
              injectTo: 'head',
            });
          }
        }
        return tags;
      },
    },
  };
}

// Every rule from src/themes/<folder>/**.css is scoped to the data-theme values that folder serves
// (THEME_IDS). :where() keeps the original specificity,
// and keyframes get a theme suffix so same-named animations don't override each other.
function collectKeyframes(dir) {
  const names = new Set()
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) return walk(p)
    if (p.endsWith('.css')) {
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/g)) names.add(m[1])
    }
  })
  if (fs.existsSync(dir)) walk(dir)
  return names
}

function themeScope() {
  const keyframesByTheme = {}
  return {
    postcssPlugin: 'theme-scope',
    Once(root) {
      const file = root.source?.input?.file
      if (!file) return
      const rel = path.relative(THEMES_DIR, file)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return
      const theme = rel.split(path.sep)[0]
      const keyframes = keyframesByTheme[theme] ||= collectKeyframes(path.join(THEMES_DIR, theme))
      const attr = `:is(${(THEME_IDS[theme] || [theme]).map(id => `[data-theme="${id}"]`).join(', ')})`
      const scope = `:where(html${attr})`
      const rename = name => `${name}--${theme}`

      root.walkAtRules(/keyframes$/, at => { if (keyframes.has(at.params)) at.params = rename(at.params) })
      root.walkDecls(/^(-webkit-)?animation(-name)?$/, decl => {
        decl.value = decl.value.replace(/[\w-]+/g, word => (keyframes.has(word) ? rename(word) : word))
      })
      root.walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return
        rule.selectors = rule.selectors.flatMap(sel => {
          const s = sel.trim()
          const root = s.match(/^(html|:root)(?![\w-])/)
          if (root) return [`${root[1]}:where(${attr})${s.slice(root[1].length)}`]
          if (s.startsWith('::')) return [`${scope}${s}`, `${scope} ${s}`]
          if (s === '*') return [scope, `${scope} *`]
          return [`${scope} ${s}`]
        })
      })
    },
  }
}
themeScope.postcss = true

// Serves /api/* during `npm run dev` with the same handlers as the Vercel functions.
const DEV_API = {
  '/api/swap': ['/api/_lib/agent.js', 'handleSwap'],
  // more specific paths first: middlewares match by prefix
  '/api/agent/act': ['/api/_lib/agentWallet.js', 'handleAgentAct'],
  '/api/agent/token': ['/api/_lib/agentWallet.js', 'handleAgentToken'],
  '/api/agent/settings': ['/api/_lib/agentWallet.js', 'handleAgentSettings'],
  '/api/agent': ['/api/_lib/agent.js', 'handleAgentIndex'],
}

function apiDev() {
  return {
    name: 'api-dev',
    apply: 'serve',
    configureServer(server) {
      // The Place API (api/place.js): /api/place/<route>?… with the same handler as the Vercel function.
      server.middlewares.use('/api/place', async (req, res) => {
        const { placeRequest, toJson } = await server.ssrLoadModule('/api/place.js')
        const url = new URL(req.url, 'http://localhost')
        let body
        if (req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          try { body = JSON.parse(raw) } catch { body = null }
        }
        const result = await placeRequest({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, ip: req.socket?.remoteAddress })
        res.statusCode = result.status
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
        res.end(result.body == null ? '' : toJson(result.body))
      })
      for (const [route, [modulePath, exportName]] of Object.entries(DEV_API)) server.middlewares.use(route, async (req, res) => {
        const handle = (await server.ssrLoadModule(modulePath))[exportName]
        let body
        if (req.method === 'PUT' || req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          try { body = JSON.parse(raw) } catch { body = null }
        }
        const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
        const result = await handle({ method: req.method, query, body, headers: req.headers })
        res.statusCode = result.status
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
        res.end(result.raw ?? JSON.stringify(result.body))
      })
    },
  }
}

export default defineConfig(({ command, mode }) => {
  // `npm run dev` runs the API functions in this process: give them the server env from .env
  if (command === 'serve') Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return {
  plugins: [react(), inlineCss(), apiDev()],
  css: {
    postcss: { plugins: [themeScope()] },
  },
  build: {
    // One stylesheet for both themes (scoped above) so the inlined CSS covers whichever theme loads.
    cssCodeSplit: false,
  },
  }
})
