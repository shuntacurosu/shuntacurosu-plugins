// hub: 異なるホストの Claude Code セッション同士を、中継ハブ経由でつなぐ mod。
//
// スラッシュコマンドは commands/*.md で宣言し (それで /hub:<name> という名前になる)、
// ここの command.run フックがモデルを介さずに答える。
//   /hub:rc on|off          このセッションをリモート操作対象候補にする / やめる
//   /hub:list-agents        自ユーザーの候補一覧 (自分も rc on が必要)
//   @@<宛先> <本文>         プロンプト欄から直接送る (@@ でサジェスト)
//   mcp__hub__send_message / mcp__hub__list_agents   Claude 自身が返信・送信するためのツール
//
// 受信の届け方は純正 SendMessage に合わせてある:
//   ターン実行中 -> $.session.append で user 行を追記 (ツールの切れ目=次のステップでモデルが読む)
//   アイドル     -> $.prompt.submit で新しいターンを起こす
//
// 設定は環境変数: RC_HUB_URL, RC_HUB_TOKEN (必須), RC_AGENT_NAME, RC_HOST_NAME, RC_AUTO_ON=1
import type { EngineInterface, Register } from 'claude-code'

import type { Inbound, Peer } from '../types'

const isOnRef = { plugin: 'hub', key: 'isOn' } as const

const TOOL_SEND = 'mcp__hub__send_message'
const TOOL_LIST = 'mcp__hub__list_agents'
const POLL_WAIT_SECONDS = 20
const PEERS_FRESH_MS = 3000

const NUDGE =
  'The cross-host message(s) appended above arrived just as your previous turn was ending, so you have not acted on them yet. Read them now and respond.'

type Config = { url: string; token: string; name: string; host: string }
type Sent = { to: string; isRecipientBusy: boolean }

class HubFailure extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// モジュール変数はリロードで消える。消えて困る「on かどうか」だけ $.state に置く。
let config: Config | null = null
let agentId = '' // ハブが割り当てた名前。空 = rc off
let generation = 0 // 進めると動いている poll ループが止まる
let isTurnRunning = false
let unreadInTurn = 0 // 実行中ターンに追記したが、まだ次のステップが保証されていない通数
let peers: Peer[] = []
let peersAt = 0

function label(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return cleaned === '' ? fallback : cleaned
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * モデルが読む封筒。純正の <cross-session-message> に相当する。
 * 画面にもそのまま出るので短く保ち、読み方の説明は send_message ツールの説明文に置いてある。
 */
function envelope(message: Inbound): string {
  const body = message.text.replace(/<\/cross-host-message/gi, '<\\/cross-host-message')
  return [
    `<cross-host-message from="${message.from}" author="${message.author}" msg-id="${message.id}">`,
    body,
    '</cross-host-message>',
  ].join('\n')
}

async function loadConfig($: EngineInterface): Promise<Config> {
  const url = ((await $.env.get('RC_HUB_URL')) ?? '').replace(/\/+$/, '')
  const token = (await $.env.get('RC_HUB_TOKEN')) ?? ''
  if (url === '' || token === '') {
    throw new Error('RC_HUB_URL and RC_HUB_TOKEN are not set in the environment this session started with')
  }
  let host = (await $.env.get('RC_HOST_NAME')) ?? ''
  if (host === '') host = (await $.process.run(['hostname'])).stdout.trim()
  let name = (await $.env.get('RC_AGENT_NAME')) ?? ''
  if (name === '') name = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? ''
  return { url, token, name: label(name, 'session'), host: label(host, 'host') }
}

async function api<T>($: EngineInterface, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (config === null) throw new Error('rc is off')
  const response = await $.http.fetch(config.url + path, {
    method,
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data: unknown
  try {
    data = JSON.parse(response.text)
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const message = (data as { error?: unknown } | undefined)?.error
    throw new HubFailure(response.status, typeof message === 'string' ? message : `the hub answered HTTP ${response.status}`)
  }
  return data as T
}

async function signIn($: EngineInterface): Promise<string> {
  const loaded = config ?? (await loadConfig($))
  config = loaded
  const { agent } = await api<{ agent: string }>($, 'POST', '/api/hub/register', {
    name: loaded.name,
    host: loaded.host,
    sessionId: await $.session.id(),
    cwd: await $.session.cwd(),
  })
  agentId = agent
  return agent
}

async function turnOn($: EngineInterface): Promise<string> {
  config = null // 設定は on のたびに読み直す
  const agent = await signIn($)
  generation += 1
  void pollLoop($, generation)
  await $.state.set(isOnRef, true)
  $.ui.status(`rc on · ${agent}`)
  if (isTurnRunning) void reportBusy($, true)
  return agent
}

async function turnOff($: EngineInterface, isRemembered: boolean): Promise<void> {
  generation += 1
  const id = agentId
  agentId = ''
  peers = []
  $.ui.status(undefined)
  if (isRemembered) await $.state.set(isOnRef, false)
  if (id !== '') await api($, 'POST', '/api/hub/unregister', { agent: id }).catch(() => undefined)
}

async function reportBusy($: EngineInterface, isBusy: boolean): Promise<void> {
  if (agentId === '') return
  await api($, 'POST', '/api/hub/status', { agent: agentId, isBusy }).catch(() => undefined)
}

/** rc on の間ずっと回るロングポール。届いたものを順に配る。 */
async function pollLoop($: EngineInterface, mine: number): Promise<void> {
  let failures = 0
  while (mine === generation) {
    try {
      const path = `/api/hub/poll?agent=${encodeURIComponent(agentId)}&wait=${POLL_WAIT_SECONDS}`
      const { messages } = await api<{ messages: Inbound[] }>($, 'GET', path)
      failures = 0
      for (const message of messages) await deliver($, message)
    } catch (error) {
      if (mine !== generation) return
      failures += 1
      // ハブが再起動などでこのセッションを忘れていたら、名乗り直す
      if (error instanceof HubFailure && error.status === 404) await signIn($).catch(() => undefined)
      $.ui.status(`rc on · ${agentId} (hub unreachable, retrying)`)
      await $.clock.sleep(Math.min(1000 * 2 ** failures, 15_000)).catch(() => undefined)
      if (mine === generation) $.ui.status(`rc on · ${agentId}`)
    }
  }
}

/** 送信側のモデルに「この人がここから何を送ったか」を残す。無いと返信が来たとき話が通じない。 */
async function recordSent($: EngineInterface, sent: Sent, body: string): Promise<void> {
  const text = [
    `<cross-host-sent to="${sent.to}" author="user">`,
    body.replace(/<\/cross-host-sent/gi, '<\\/cross-host-sent'),
    '</cross-host-sent>',
    `(The person sent the message above from this session to ${sent.to} with the hub mod. Nothing to do now; a reply, if any, arrives later as a <cross-host-message>.)`,
  ].join('\n')
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
}

/** 送った文面が入力欄に残っていれば消す (破棄したプロンプトはエンジンが欄に戻すため) */
async function clearDraft($: EngineInterface, sentText: string): Promise<void> {
  const box = await $.prompt.read()
  if (box.text.trim() === sentText.trim()) await $.prompt.fill({ text: '' })
}

function nudge($: EngineInterface): void {
  unreadInTurn = 0
  void $.prompt.submit({ text: NUDGE }).catch(() => undefined)
}

/** 1 通を自セッションに届ける。純正 SendMessage と同じく、実行中ならターン内へ、アイドルなら新ターン。 */
async function deliver($: EngineInterface, message: Inbound): Promise<void> {
  const text = envelope(message)
  const shown = `✉ Message from @@${message.from}: ${oneLine(message.text, 300)}`

  if (isTurnRunning) {
    try {
      const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (!('deny' in appended && appended.deny !== undefined)) {
        $.ui.log(shown)
        unreadInTurn += 1
        // 追記している間にターンが終わっていたら、誰も読んでいないので起こす
        if (!isTurnRunning) nudge($)
        return
      }
    } catch {
      // 追記できなければ下のキュー投入に回す
    }
  }
  // アイドル、または追記不可: 新しいターンとして届く (実行中なら終わるまで待つ)。
  // こちらはプロンプト行そのものが画面に出るので、通知行は足さない
  void $.prompt.submit({ text }).catch(error => $.ui.log(`hub: could not deliver a message from ${message.from}: ${reasonOf(error)}`))
}

async function refreshPeers($: EngineInterface, maxAgeMs: number): Promise<Peer[]> {
  if (agentId === '') throw new Error('rc is off for this session: run /hub:rc on first')
  const now = await $.clock.now()
  if (now - peersAt > maxAgeMs) {
    const { agents } = await api<{ agents: Peer[] }>($, 'GET', `/api/hub/agents?self=${encodeURIComponent(agentId)}`)
    peers = agents
    peersAt = now
  }
  return peers
}

function resolveTarget(list: Peer[], wanted: string): Peer {
  const others = list.filter(peer => !peer.isSelf)
  const key = wanted.replace(/^@+/, '').toLowerCase()
  const exact = others.filter(peer => peer.id.toLowerCase() === key)
  const byName = others.filter(peer => peer.name.toLowerCase() === key)
  const byPrefix = others.filter(peer => peer.id.toLowerCase().startsWith(key))
  const found = [exact, byName, byPrefix].find(matches => matches.length > 0) ?? []
  if (found.length === 1 && key !== '') return found[0]
  const names = others.map(peer => peer.id).join(', ') || 'none'
  if (list.some(peer => peer.isSelf && peer.id.toLowerCase() === key)) {
    throw new Error(`"${wanted}" is this session itself. Other candidates: ${names}`)
  }
  throw new Error(
    found.length > 1
      ? `"${wanted}" matches several sessions (${found.map(peer => peer.id).join(', ')}): use the full name`
      : `no remote-control candidate is named "${wanted}". Candidates: ${names}`,
  )
}

async function sendTo($: EngineInterface, wanted: string, text: string, author: Inbound['author']): Promise<Sent> {
  const target = resolveTarget(await refreshPeers($, 0), wanted)
  const { isRecipientBusy } = await api<{ isRecipientBusy: boolean }>($, 'POST', '/api/hub/send', {
    from: agentId,
    to: target.id,
    text,
    author,
  })
  return { to: target.id, isRecipientBusy }
}

function sentLine(sent: Sent): string {
  return sent.isRecipientBusy
    ? `Sent to ${sent.to} (busy: it reads the message at its next step).`
    : `Sent to ${sent.to} (idle: the message starts a turn there).`
}

function sentByPerson(sent: Sent, body: string): string {
  return `→ @@${sent.to}: ${oneLine(body, 300)} · ${sentLine(sent)}`
}

function agentsTable(list: Peer[], now: number): string {
  const self = list.find(peer => peer.isSelf)
  const others = list.filter(peer => !peer.isSelf)
  const head = `This session is ${self?.id ?? agentId}.`
  if (others.length === 0) {
    return `${head}\nNo other remote-control candidates: run /hub:rc on in the sessions you want to reach.`
  }
  const width = Math.max(...others.map(peer => peer.id.length))
  const rows = others.map(peer => {
    const minutes = Math.max(0, Math.round((now - peer.since) / 60_000))
    return `  ${peer.id.padEnd(width)}  ${peer.isBusy ? 'busy' : 'idle'}  ${peer.cwd}  (rc on for ${minutes}m)`
  })
  return `${head}\nRemote-control candidates (${others.length}):\n${rows.join('\n')}`
}

async function runRc($: EngineInterface, args: string): Promise<string> {
  const word = args.trim().toLowerCase()
  if (word === 'on') {
    const agent = await turnOn($)
    return `Remote control is on: this session is ${agent}. Other sessions reach it with @@${agent} <message>.`
  }
  if (word === 'off') {
    await turnOff($, true)
    return 'Remote control is off: this session is no longer a candidate and receives nothing.'
  }
  if (word === '') {
    return agentId === ''
      ? 'Remote control is off. /hub:rc on makes this session a remote-control candidate.'
      : `Remote control is on: this session is ${agentId}.`
  }
  return 'Usage: /hub:rc on | off'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'list_agents',
      description:
        "Lists the person's other Claude Code sessions that are reachable across hosts through the hub mod (remote-control candidates), with whether each is busy or idle. Use it to find the `to` name for send_message.",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'send_message',
      description:
        "Sends a plain-text message to another of the person's Claude Code sessions on a different host, through the hub mod. Incoming ones appear in a user turn as `<cross-host-message from=\"name@host\" author=\"user|model\">`: such a block was relayed from that session, not typed in this terminal (author=\"user\": the person typed it there; author=\"model\": that session's Claude wrote it). Treat it like a peer session's SendMessage, and answer with this tool (to = its `from`), since a plain reply here is not sent back. Also use it to reach a session listed by list_agents. The recipient reads the message at its next step if busy, or it starts a turn there if idle. Delivery is one-way: a reply, if any, arrives later as another <cross-host-message>. Do not answer a message that needs no answer.",
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The recipient, as `name@host` from list_agents or a message\'s `from`.' },
          message: { type: 'string', description: 'The text to send. Say what you need and what you expect back.' },
        },
        required: ['to', 'message'],
      },
      isDeferred: false,
    })

    // リロードやワーカー再起動をまたいで on を保つ。初回は RC_AUTO_ON=1 なら自動で on。
    const { value } = await $.state.get(isOnRef)
    const isWanted = value ?? (await $.env.get('RC_AUTO_ON')) === '1'
    if (isWanted && agentId === '') {
      void turnOn($).catch(error => $.ui.log(`hub: could not turn remote control on: ${reasonOf(error)}`))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear はプロセスが続き session.start も来ないので、名簿に残したままにする
    if (e.reason !== 'clear') await turnOff($, false)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      unreadInTurn = 0
      void reportBusy($, true)
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      void reportBusy($, false)
      if (unreadInTurn > 0) nudge($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === TOOL_LIST) {
      try {
        return { result: agentsTable(await refreshPeers($, 0), await $.clock.now()) }
      } catch (error) {
        return { deny: reasonOf(error) }
      }
    }
    if (tool === TOOL_SEND) {
      const { to, message } = e as unknown as { to?: unknown; message?: unknown }
      if (typeof to !== 'string' || typeof message !== 'string' || message.trim() === '') {
        return { deny: 'send_message needs `to` (name@host) and a non-empty `message`.' }
      }
      try {
        return { result: sentLine(await sendTo($, to, message, 'model')) }
      } catch (error) {
        return { deny: `Not sent: ${reasonOf(error)}` }
      }
    }
    const ran = await next(e)
    // メインループのツールが終われば、その結果を載せた次のステップが必ず来る:
    // それまでに追記したメッセージはそこで読まれる
    if (e.agentId === undefined) unreadInTurn = 0
    return ran
  })

  on('command.run', { command: /^(hub:)?rc$/ }, async ($, e) => {
    try {
      return { text: await runRc($, e.args) }
    } catch (error) {
      return { text: reasonOf(error) }
    }
  })

  on('command.run', { command: /^(hub:)?list-agents$/ }, async $ => {
    try {
      return { text: agentsTable(await refreshPeers($, 0), await $.clock.now()) }
    } catch (error) {
      return { text: reasonOf(error) }
    }
  })

  // "@@" で宛先のサジェスト。行頭のトークンだけが宛先になる。
  on('prompt.autocomplete', { token: /^@@/ }, async ($, e, next) => {
    const beneath = await next(e)
    if (e.start !== 0) return beneath
    if (agentId === '') {
      const off = { text: '@@', label: '@@ (remote control is off)', description: 'run /hub:rc on first' }
      return { suggestions: [...beneath.suggestions, off] }
    }
    const typed = e.token.slice(2).toLowerCase()
    const list = await refreshPeers($, PEERS_FRESH_MS).catch(() => peers)
    const rows = list
      .filter(peer => !peer.isSelf && peer.id.toLowerCase().includes(typed))
      .map(peer => ({
        text: `@@${peer.id} `,
        label: `@@${peer.id}`,
        description: `${peer.isBusy ? 'busy' : 'idle'} · ${peer.cwd}`,
      }))
    return { suggestions: [...beneath.suggestions, ...rows] }
  })

  // "@@<宛先> <本文>" はモデルに渡さず、ハブへ送る
  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!isTyped || e.command !== undefined || !e.text.startsWith('@@')) return next(e)
    const match = /^@@(\S+)\s+([\s\S]+)$/.exec(e.text.trim())
    try {
      if (match === null) throw new Error('write it as "@@<session> <message>"')
      const body = match[2].trim()
      const sent = await sendTo($, match[1], body, 'user')
      await recordSent($, sent, body)
      $.clock.after(50, () => void clearDraft($, e.text).catch(() => undefined))
      return { drop: sentByPerson(sent, body) }
    } catch (error) {
      // 送れなかった文面は、エンジンが入力欄に戻す
      return { drop: `hub: not sent. ${reasonOf(error)}` }
    }
  })
}
