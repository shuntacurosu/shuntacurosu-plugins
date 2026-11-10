import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Hub, HubError } from './hub.js'

function setup() {
  let now = 1_000_000
  const hub = new Hub({ now: () => now })
  const a = hub.register('u1', { name: 'alpha', host: 'host-a', sessionId: 's1', cwd: '/w' }).agent
  const b = hub.register('u1', { name: 'bravo', host: 'host-b', sessionId: 's2', cwd: '/w' }).agent
  return { hub, a, b, advance: ms => (now += ms) }
}

test('a message sent before the poll is returned by the next poll', async () => {
  const { hub, a, b } = setup()
  const sent = hub.send('u1', { from: a, to: b, text: 'hi', author: 'user' })
  const { messages } = await hub.poll('u1', b, 1000).promise
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, sent.msgId)
  assert.deepEqual(
    { from: messages[0].from, text: messages[0].text, author: messages[0].author },
    { from: 'alpha@host-a', text: 'hi', author: 'user' },
  )
})

test('a waiting poll is woken by a send, and delivers once', async () => {
  const { hub, a, b } = setup()
  const waiting = hub.poll('u1', b, 20_000).promise
  hub.send('u1', { from: a, to: b, text: 'wake', author: 'model' })
  assert.equal((await waiting).messages[0].text, 'wake')
  const second = hub.poll('u1', b, 0)
  assert.deepEqual((await second.promise).messages, [])
})

test('a newer poll supersedes an older one without losing messages', async () => {
  const { hub, a, b } = setup()
  const older = hub.poll('u1', b, 20_000).promise
  const newer = hub.poll('u1', b, 20_000).promise
  assert.deepEqual((await older).messages, [])
  hub.send('u1', { from: a, to: b, text: 'x', author: 'user' })
  assert.equal((await newer).messages.length, 1)
})

test('listing needs the caller to be registered, and marks self', () => {
  const { hub, a } = setup()
  assert.throws(() => hub.list('u1', 'nobody@host'), error => error instanceof HubError && error.status === 403)
  const { agents } = hub.list('u1', a)
  assert.deepEqual(agents.map(agent => [agent.id, agent.isSelf]), [
    ['alpha@host-a', true],
    ['bravo@host-b', false],
  ])
})

test("users never see or reach each other's sessions", () => {
  const { hub, b } = setup()
  const c = hub.register('u2', { name: 'carol', host: 'host-c', sessionId: 's3', cwd: '/' }).agent
  assert.deepEqual(hub.list('u2', c).agents.map(agent => agent.id), ['carol@host-c'])
  assert.throws(
    () => hub.send('u2', { from: c, to: b, text: 'hi', author: 'user' }),
    error => error.status === 404,
  )
})

test('a second live session with the same name gets a suffix; the same session keeps its id', () => {
  const { hub, a } = setup()
  hub.poll('u1', a, 20_000) // s1 は生きていて poll 中
  assert.equal(hub.register('u1', { name: 'alpha', host: 'host-a', sessionId: 'other', cwd: '/' }).agent, 'alpha-2@host-a')
  assert.equal(hub.register('u1', { name: 'alpha', host: 'host-a', sessionId: 's1', cwd: '/' }).agent, 'alpha@host-a')
})

test('a session killed without rc off gives its name and unread messages to its successor', async () => {
  const { hub, a, b, advance } = setup()
  const dying = hub.poll('u1', b, 20_000)
  dying.cancel() // コンテナが落ちて接続が切れた
  advance(1_000)
  hub.send('u1', { from: a, to: b, text: 'sent while bravo restarts', author: 'user' })
  advance(4_000)
  const successor = hub.register('u1', { name: 'bravo', host: 'host-b', sessionId: 'restarted', cwd: '/w' }).agent
  assert.equal(successor, 'bravo@host-b')
  assert.equal((await hub.poll('u1', successor, 0).promise).messages[0].text, 'sent while bravo restarts')
})

test('a dead session leaves the list ten seconds after its last poll ends', () => {
  const { hub, a, b, advance } = setup()
  hub.poll('u1', a, 20_000)
  hub.poll('u1', b, 20_000).cancel()
  advance(9_000)
  assert.equal(hub.list('u1', a).agents.length, 2)
  advance(2_000)
  assert.deepEqual(hub.list('u1', a).agents.map(agent => agent.id), ['alpha@host-a'])
})

test('re-registering the same session keeps its unread messages', async () => {
  const { hub, a, b } = setup()
  hub.send('u1', { from: a, to: b, text: 'kept', author: 'user' })
  hub.register('u1', { name: 'bravo', host: 'host-b', sessionId: 's2', cwd: '/w' })
  assert.equal((await hub.poll('u1', b, 0).promise).messages[0].text, 'kept')
})

test('an agent that stops polling drops off the list, and sends to it fail', () => {
  const { hub, a, b, advance } = setup()
  hub.poll('u1', a, 20_000) // a は poll を張っていて生きている。b は何もしていない
  advance(30_000)
  assert.deepEqual(hub.list('u1', a).agents.map(agent => agent.id), ['alpha@host-a'])
  assert.throws(() => hub.send('u1', { from: a, to: b, text: 'hi', author: 'user' }), error => error.status === 404)
})

test('refuses empty messages, self-sends and unregistered senders', () => {
  const { hub, a, b } = setup()
  assert.throws(() => hub.send('u1', { from: a, to: b, text: '  ', author: 'user' }), error => error.status === 400)
  assert.throws(() => hub.send('u1', { from: a, to: a, text: 'x', author: 'user' }), error => error.status === 400)
  hub.unregister('u1', a)
  assert.throws(() => hub.send('u1', { from: a, to: b, text: 'x', author: 'user' }), error => error.status === 404)
})

test('busy state shows in the list and in the send result', () => {
  const { hub, a, b } = setup()
  hub.setBusy('u1', b, true)
  assert.equal(hub.list('u1', a).agents.find(agent => agent.id === b).isBusy, true)
  assert.equal(hub.send('u1', { from: a, to: b, text: 'x', author: 'user' }).isRecipientBusy, true)
})
