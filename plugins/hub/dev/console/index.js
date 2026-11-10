// 検証用サーバ: (1) 中継ハブの HTTP API  (2) xterm + tmux の Web コンソール
//
//   /api/hub/*     … mod (各セッションの claude) が叩く。Bearer トークンでユーザーを識別。
//   /api/sessions  … 左ペイン用。ラベル rc.session の付いたコンテナ一覧。
//   /term?c=NAME   … WebSocket。docker exec でそのコンテナの tmux に attach する。
//
// 本番ではユーザー識別 (userOf) を GitLab OAuth のセッションに差し替える想定。

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Hub, HubError } from '../../server/hub.js'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8080)

// "token:user,token2:user2"
const TOKENS = new Map(
  (process.env.RC_TOKENS ?? 'dev-token:dev')
    .split(',')
    .map(pair => pair.trim().split(':'))
    .filter(pair => pair.length === 2 && pair[0] !== ''),
)

const hub = new Hub()

function userOf(request) {
  const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')
  const user = match ? TOKENS.get(match[1]) : undefined
  if (user === undefined) throw new HubError(401, 'unknown or missing hub token')
  return user
}

async function bodyOf(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new HubError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HubError(400, 'request body is not JSON')
  }
}

function json(response, status, value) {
  const text = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(text)
}

async function hubApi(request, response, url) {
  const user = userOf(request)
  const route = `${request.method} ${url.pathname.slice('/api/hub'.length)}`
  switch (route) {
    case 'POST /register':
      return json(response, 200, hub.register(user, await bodyOf(request)))
    case 'POST /unregister':
      return json(response, 200, hub.unregister(user, (await bodyOf(request)).agent))
    case 'POST /status': {
      const body = await bodyOf(request)
      return json(response, 200, hub.setBusy(user, body.agent, body.isBusy))
    }
    case 'GET /agents':
      return json(response, 200, hub.list(user, url.searchParams.get('self') ?? ''))
    case 'POST /send': {
      const result = hub.send(user, await bodyOf(request))
      console.log(`[hub] ${user}: message ${result.msgId} relayed`)
      return json(response, 200, result)
    }
    case 'GET /poll': {
      const waitMs = Number(url.searchParams.get('wait') ?? 20) * 1000
      const { promise, cancel } = hub.poll(user, url.searchParams.get('agent') ?? '', waitMs)
      response.on('close', cancel)
      return json(response, 200, await promise)
    }
    default:
      throw new HubError(404, `no such hub route: ${route}`)
  }
}

// ---- Web コンソール --------------------------------------------------------

async function listSessions() {
  const { stdout } = await run('docker', [
    'ps',
    '--filter',
    'label=rc.session',
    '--format',
    '{{.Names}}\t{{.Label "rc.host"}}\t{{.Status}}',
  ])
  const registered = new Map(hub.snapshot().map(agent => [agent.id, agent]))
  return stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [container, host, status] = line.split('\t')
      const prefix = new RegExp(`^${escapeRegExp(container)}(-\\d+)?@${escapeRegExp(host)}$`)
      const agents = [...registered.values()].filter(agent => prefix.test(agent.id))
      return { container, host, status, agents: agents.map(a => ({ id: a.id, isBusy: a.isBusy })) }
    })
    .sort((a, b) => `${a.host}/${a.container}`.localeCompare(`${b.host}/${b.container}`))
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const STATIC = new Map([
  ['/', [join(here, 'public/index.html'), 'text/html; charset=utf-8']],
  ['/vendor/xterm.js', [require.resolve('@xterm/xterm/lib/xterm.js'), 'text/javascript']],
  ['/vendor/xterm.css', [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css']],
  ['/vendor/addon-fit.js', [require.resolve('@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript']],
])

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/hub/')) return await hubApi(request, response, url)
    if (url.pathname === '/api/sessions') return json(response, 200, { sessions: await listSessions() })
    if (url.pathname === '/favicon.ico') return response.writeHead(204).end()
    const file = STATIC.get(url.pathname)
    if (file && request.method === 'GET') {
      response.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' })
      return response.end(await readFile(file[0]))
    }
    throw new HubError(404, 'not found')
  } catch (error) {
    const status = error instanceof HubError ? error.status : 500
    if (status === 500) console.error(error)
    if (!response.headersSent) json(response, status, { error: String(error.message ?? error) })
    else response.end()
  }
})

// 端末: ブラウザの xterm <-> node-pty <-> docker exec -it <container> tmux attach
async function attachTerminals() {
  const { WebSocketServer } = await import('ws')
  const pty = (await import('node-pty')).default
  const sockets = new WebSocketServer({ noServer: true })

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const container = url.searchParams.get('c') ?? ''
    const known = url.pathname === '/term' ? await listSessions().catch(() => []) : []
    if (!known.some(session => session.container === container)) return socket.destroy()

    sockets.handleUpgrade(request, socket, head, ws => {
      const term = pty.spawn(
        'docker',
        ['exec', '-it', '-e', 'TERM=xterm-256color', container, 'tmux', 'attach', '-t', 'main'],
        { name: 'xterm-256color', cols: 120, rows: 36 },
      )
      term.onData(data => ws.readyState === ws.OPEN && ws.send(data))
      term.onExit(() => ws.close())
      ws.on('message', raw => {
        let message
        try {
          message = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (message.type === 'input' && typeof message.data === 'string') term.write(message.data)
        if (message.type === 'resize' && message.cols > 0 && message.rows > 0) {
          term.resize(Math.min(message.cols, 500), Math.min(message.rows, 200))
        }
      })
      ws.on('close', () => term.kill())
    })
  })
}

if (process.env.RC_NO_TERMINALS !== '1') await attachTerminals()

server.listen(PORT, () => console.log(`rc-server listening on :${PORT} (users: ${[...new Set(TOKENS.values())].join(', ')})`))
