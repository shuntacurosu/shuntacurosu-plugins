// 中継ハブの参考実装 (依存パッケージなし)。
//
//   RC_TOKENS="tokenA:alice,tokenB:bob" PORT=8080 node index.js
//
// hub プラグインを入れた各セッションが、ここへ外向きの HTTP だけでつながる。
// 名簿と受信箱はユーザーごとに分かれ、別ユーザーのセッションは見えも届きもしない。
//
// 自分の環境に合わせて差し替えるのは userOf() だけ: リクエストから「誰のセッションか」を返す。
// この見本は固定のトークン表を引いている。

import { createServer } from 'node:http'

import { Hub, HubError } from './hub.js'

const PORT = Number(process.env.PORT ?? 8080)

// "token:user,token2:user2"
const TOKENS = new Map(
  (process.env.RC_TOKENS ?? '')
    .split(',')
    .map(pair => pair.trim().split(':'))
    .filter(pair => pair.length === 2 && pair[0] !== '' && pair[1] !== ''),
)
if (TOKENS.size === 0) {
  console.error('RC_TOKENS is empty. Set it to "token:user[,token:user...]" so sessions can sign in.')
  process.exit(1)
}

const hub = new Hub()

/** 認証の継ぎ目: Bearer トークンからユーザーを決める。分からなければ 401。 */
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
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function route(request, response, url) {
  if (!url.pathname.startsWith('/api/hub/')) throw new HubError(404, 'not found')
  const user = userOf(request)
  const name = `${request.method} ${url.pathname.slice('/api/hub'.length)}`
  switch (name) {
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
    case 'POST /send':
      return json(response, 200, hub.send(user, await bodyOf(request)))
    case 'GET /poll': {
      const waitMs = Number(url.searchParams.get('wait') ?? 20) * 1000
      const { promise, cancel } = hub.poll(user, url.searchParams.get('agent') ?? '', waitMs)
      response.on('close', cancel) // セッションが落ちて接続が切れたら、待ちをやめる
      return json(response, 200, await promise)
    }
    default:
      throw new HubError(404, `no such hub route: ${name}`)
  }
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response, new URL(request.url ?? '/', 'http://localhost'))
  } catch (error) {
    const status = error instanceof HubError ? error.status : 500
    if (status === 500) console.error(error)
    if (!response.headersSent) json(response, status, { error: String(error.message ?? error) })
    else response.end()
  }
})

server.listen(PORT, () => {
  console.log(`hub relay listening on :${PORT} (${new Set(TOKENS.values()).size} user(s))`)
})
