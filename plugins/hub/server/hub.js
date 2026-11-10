// 中継ハブ本体 (HTTP から独立した純粋なロジック)。
// ユーザーごとに「rc on したセッション (agent)」の名簿と受信箱を持ち、
// 異なるホストのセッション同士はここを経由してだけ会話する。

import { randomUUID } from 'node:crypto'

// 生きている agent は常にロングポールを張っている。張っていない時間がこれを超えたら落ちたとみなす
// (poll と poll の間の往復や、届いたメッセージを配っている間のための猶予)。
const GRACE_MS = 10_000
// 同じ名前で別セッションが名乗ってきたとき、前の持ち主がこれだけ poll していなければ席を譲る
// (コンテナの強制再起動など、rc off を言えずに消えたセッションの後継)。
const TAKEOVER_MS = 2_000
const MAX_TEXT = 100_000
const MAX_INBOX = 200

export class HubError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export class Hub {
  /** @param {{ now?: () => number }} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now
    /** @type {Map<string, Map<string, Agent>>} user -> agentId -> agent */
    this.users = new Map()
  }

  #agentsOf(user) {
    let agents = this.users.get(user)
    if (!agents) this.users.set(user, (agents = new Map()))
    return agents
  }

  #isAlive(agent) {
    return agent.waiter !== null || this.now() - agent.lastSeen < GRACE_MS
  }

  #prune(user) {
    const agents = this.#agentsOf(user)
    for (const [id, agent] of agents) if (!this.#isAlive(agent)) agents.delete(id)
    return agents
  }

  #live(user, agentId) {
    const agent = this.#prune(user).get(agentId)
    if (!agent) {
      throw new HubError(404, `"${agentId}" is not a remote-control candidate (rc off, or its session ended)`)
    }
    return agent
  }

  /**
   * rc on: 名簿に載せる。同じ名前の別セッションが生きていれば -2, -3 … を付ける。
   * 前の持ち主が消えていれば名前と未読を引き継ぐ (宛先は「その名前の席」なので)。
   */
  register(user, { name, host, sessionId, cwd }) {
    if (!isLabel(name) || !isLabel(host)) {
      throw new HubError(400, 'name and host must be 1-64 characters of letters, digits, ".", "_" or "-"')
    }
    const agents = this.#prune(user)
    let id = `${name}@${host}`
    const isTaken = candidate => {
      const holder = agents.get(candidate)
      if (holder === undefined || holder.sessionId === sessionId) return false
      return holder.waiter !== null || this.now() - holder.lastSeen < TAKEOVER_MS
    }
    for (let n = 2; isTaken(id); n += 1) id = `${name}-${n}@${host}`
    const previous = agents.get(id)
    const agent = {
      id,
      name: id.slice(0, id.lastIndexOf('@')),
      host,
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      isBusy: false,
      since: previous?.since ?? this.now(),
      lastSeen: this.now(),
      inbox: previous?.inbox ?? [],
      waiter: null,
    }
    previous?.waiter?.([])
    agents.set(id, agent)
    return { agent: id }
  }

  /** rc off / セッション終了 */
  unregister(user, agentId) {
    const agents = this.#agentsOf(user)
    const agent = agents.get(agentId)
    agent?.waiter?.([])
    return { removed: agents.delete(agentId) }
  }

  setBusy(user, agentId, isBusy) {
    const agent = this.#live(user, agentId)
    agent.isBusy = Boolean(isBusy)
    agent.lastSeen = this.now()
    return { ok: true }
  }

  /** 自ユーザーの候補一覧。呼ぶ側も rc on していること (双方向通信のため)。 */
  list(user, selfId) {
    const agents = this.#prune(user)
    if (!agents.has(selfId)) {
      throw new HubError(403, 'this session is not a remote-control candidate itself: turn rc on first')
    }
    return {
      agents: [...agents.values()].map(agent => ({
        id: agent.id,
        name: agent.name,
        host: agent.host,
        cwd: agent.cwd,
        isBusy: agent.isBusy,
        isSelf: agent.id === selfId,
        since: agent.since,
      })),
    }
  }

  /** 送信: 宛先の受信箱に積み、待っている poll があればすぐ起こす。 */
  send(user, { from, to, text, author }) {
    const sender = this.#live(user, from)
    sender.lastSeen = this.now()
    if (typeof text !== 'string' || text.trim() === '') throw new HubError(400, 'the message is empty')
    if (text.length > MAX_TEXT) throw new HubError(413, `the message is over ${MAX_TEXT} characters`)
    if (to === from) throw new HubError(400, `"${to}" is this session itself`)
    const target = this.#live(user, to)
    if (target.inbox.length >= MAX_INBOX) throw new HubError(429, `"${to}" has ${MAX_INBOX} unread messages`)
    const message = {
      id: randomUUID(),
      from,
      to,
      author: author === 'model' ? 'model' : 'user',
      text,
      sentAt: this.now(),
    }
    target.inbox.push(message)
    this.#flush(target)
    return { ok: true, msgId: message.id, isRecipientBusy: target.isBusy }
  }

  #flush(agent) {
    if (agent.waiter === null || agent.inbox.length === 0) return
    const waiter = agent.waiter
    agent.waiter = null
    waiter(agent.inbox.splice(0))
  }

  /**
   * ロングポール: メッセージが来るか waitMs 経つまで待つ。生存確認も兼ねる。
   * 同じ agent の古い poll は空で返す (最後の 1 本だけが受け取る)。
   * @returns {{ promise: Promise<{ messages: object[] }>, cancel: () => void }}
   */
  poll(user, agentId, waitMs) {
    const agent = this.#live(user, agentId)
    agent.lastSeen = this.now()
    agent.waiter?.([])
    agent.waiter = null
    if (agent.inbox.length > 0) {
      return { promise: Promise.resolve({ messages: agent.inbox.splice(0) }), cancel() {} }
    }
    let settle
    const promise = new Promise(resolve => (settle = resolve))
    const waiter = messages => {
      clearTimeout(timer)
      if (agent.waiter === waiter) agent.waiter = null
      agent.lastSeen = this.now()
      settle({ messages })
    }
    const timer = setTimeout(() => waiter([]), Math.max(0, Math.min(waitMs, 30_000)))
    agent.waiter = waiter
    return { promise, cancel: () => waiter([]) }
  }

  /** 管理用の一覧: 全ユーザーの候補 (本文は含めない) */
  snapshot() {
    const rows = []
    for (const user of this.users.keys()) {
      for (const agent of this.#prune(user).values()) {
        rows.push({ user, id: agent.id, name: agent.name, host: agent.host, isBusy: agent.isBusy })
      }
    }
    return rows
  }
}

function isLabel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value)
}

/**
 * @typedef {{ id: string, name: string, host: string, sessionId: string, cwd: string,
 *   isBusy: boolean, since: number, lastSeen: number, inbox: object[],
 *   waiter: ((messages: object[]) => void) | null }} Agent
 */
