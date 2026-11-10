// 検証用 mod: ターン実行中に「外から来たメッセージ」を差し込めるかを経路別に測る。
//   PROBE_MODE=append   -> $.session.append (user 行をその場で追記)
//   PROBE_MODE=selfsend -> $.session.send を自セッション宛てに (純正 SendMessage の配送路)
//   PROBE_MODE=udsself  -> $.session.send を自分の uds ソケット宛てに
//   PROBE_MODE=submit   -> $.prompt.submit (アイドル待ちのキュー)
//   PROBE_MODE=none     -> 何もしない (対照)
// 最初のターン開始から PROBE_DELAY_MS 後に 1 回だけ注入し、時系列を /tmp/probe.log に残す。
import type { EngineInterface, Register } from 'claude-code'

let logPath = ''
const SECRET = 'The codeword is PINEAPPLE-42. (cross-host test message)'

const lines: string[] = []
let t0 = 0
let isArmed = false

async function log($: EngineInterface, text: string): Promise<void> {
  const now = await $.clock.now()
  if (t0 === 0) t0 = now
  lines.push(`${((now - t0) / 1000).toFixed(1).padStart(5)}s  ${text}`)
  if (logPath === '') logPath = (await $.env.get('PROBE_LOG')) ?? '/tmp/probe.log'
  await $.fs.write(logPath, lines.join('\n') + '\n')
}

async function inject($: EngineInterface, mode: string): Promise<void> {
  await log($, `inject begin mode=${mode}`)
  try {
    if (mode === 'append') {
      const result = await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text: SECRET }] },
      })
      await log($, `inject append -> ${JSON.stringify(result).slice(0, 200)}`)
    } else if (mode === 'selfsend') {
      const sessionId = await $.session.id()
      const result = await $.session.send({ to: { sessionId }, text: SECRET })
      await log($, `inject selfsend -> ${JSON.stringify(result)}`)
    } else if (mode === 'udsself') {
      // 自プロセスのピア用ソケットを直接名指しする
      const { stdout } = await $.process.run(['sh', '-c', 'echo $PPID'])
      const to = `uds:/tmp/cc-socks/${stdout.trim()}.sock`
      const result = await $.session.send({ to, text: SECRET })
      await log($, `inject udsself to=${to} -> ${JSON.stringify(result)}`)
    } else if (mode === 'submit') {
      const result = await $.prompt.submit({ text: SECRET })
      await log($, `inject submit -> ${JSON.stringify(result).slice(0, 200)}`)
    }
  } catch (error) {
    await log($, `inject FAILED: ${String(error)}`)
  }
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await log($, `turn.start text=${JSON.stringify(e.text.slice(0, 60))}`)
    if (!isArmed) {
      isArmed = true
      const mode = (await $.env.get('PROBE_MODE')) ?? 'append'
      const delay = Number((await $.env.get('PROBE_DELAY_MS')) ?? '8000')
      $.clock.after(delay, () => void inject($, mode))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await log($, `turn.step index=${e.index} messageCount=${e.messageCount}`)
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    await log($, `tool.call begin ${e.tool}`)
    const result = await next(e)
    await log($, `tool.call end   ${e.tool}`)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await log(
      $,
      `prompt.submit origin=${JSON.stringify(e.origin)} turnId=${e.turnId ?? '-'} isMeta=${e.isMeta ?? false}`,
    )
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    await log($, `session.receive origin=${JSON.stringify(e.origin)} text=${JSON.stringify(e.text.slice(0, 80))}`)
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    if (e.door !== 'response') {
      await log($, `session.append door=${e.door} origin=${JSON.stringify(e.origin)}`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await log($, `turn.complete reason=${e.reason} answer=${JSON.stringify(e.answer.slice(0, 160))}`)
    }
    return next(e)
  })
}
