/** 名簿の 1 行: rc on している自ユーザーのセッション */
export type Peer = {
  /** `<name>@<host>`: 宛先として使う名前 */
  id: string
  name: string
  host: string
  cwd: string
  isBusy: boolean
  isSelf: boolean
  /** rc on した時刻 (epoch ms) */
  since: number
}

/** ハブから届いた 1 通 */
export type Inbound = {
  id: string
  from: string
  to: string
  /** `user`: 送信側の人が打った / `model`: 送信側の Claude がツールで送った */
  author: 'user' | 'model'
  text: string
  sentAt: number
}

declare module 'claude-code' {
  interface PluginState {
    hub: { isOn: boolean }
  }
}
