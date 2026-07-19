import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from './pipeline.ts'
import type { Step, TenantSpec } from './types.ts'

const spec: TenantSpec = { slug: 'acme', name: 'Acme', adminEmail: 'a@acme.test' }

function step(name: string, fn?: Step['run']): Step {
  return { name, run: fn ?? (async () => {}) }
}

test('runs steps in order and merges returned state', async () => {
  const order: string[] = []
  const result = await runPipeline({
    spec,
    steps: [
      step('one', async () => {
        order.push('one')
        return { projectRef: 'abc123' }
      }),
      step('two', async ({ state }) => {
        order.push('two')
        assert.equal(state.projectRef, 'abc123')
        return { appUrl: 'https://acme.supanet.io' }
      }),
    ],
  })
  assert.deepEqual(order, ['one', 'two'])
  assert.equal(result.ok, true)
  assert.equal(result.state.appUrl, 'https://acme.supanet.io')
  assert.equal(result.steps.length, 2)
})

test('a throwing step stops the run and reports failedStep', async () => {
  let ranThird = false
  const result = await runPipeline({
    spec,
    steps: [
      step('one'),
      step('boom', async () => {
        throw new Error('nope')
      }),
      step('three', async () => {
        ranThird = true
      }),
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'boom')
  assert.equal(ranThird, false)
  assert.equal(result.steps.at(-1)?.error, 'nope')
})

test('resume skips completed steps but keeps prior state', async () => {
  let reranOne = false
  const result = await runPipeline({
    spec,
    completed: ['one'],
    initialState: { projectRef: 'kept' },
    steps: [
      step('one', async () => {
        reranOne = true
      }),
      step('two', async ({ state }) => {
        assert.equal(state.projectRef, 'kept')
      }),
    ],
  })
  assert.equal(reranOne, false)
  assert.equal(result.ok, true)
})

test('persist is called after every step, including failures', async () => {
  const snapshots: number[] = []
  await runPipeline({
    spec,
    steps: [
      step('one'),
      step('boom', async () => {
        throw new Error('x')
      }),
    ],
    persist: ({ steps }) => {
      snapshots.push(steps.length)
    },
  })
  assert.deepEqual(snapshots, [1, 2])
})
