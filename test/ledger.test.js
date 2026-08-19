import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { openLedger } from '../lib/ledger.js'

function tmpFile () {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-ledger-'))
  const file = path.join(dir, 'nested', 'ledger.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  return { dir, file }
}

test('append/readAll roundtrip with correct event shape', () => {
  const { dir, file } = tmpFile()
  try {
    const ledger = openLedger(file)
    const ev = ledger.append('task_start', { task: 't1' }, 'trial-1')
    assert.equal(typeof ev.seq, 'number')
    assert.equal(ev.seq, 1)
    assert.ok(typeof ev.ts === 'string' && ev.ts.endsWith('Z'))
    assert.equal(ev.schemaVersion, '1')
    assert.equal(ev.trialId, 'trial-1')
    assert.equal(ev.type, 'task_start')
    assert.deepEqual(ev.data, { task: 't1' })
    assert.equal(ledger.count, 1)
    const { events, badLines } = ledger.readAll()
    assert.equal(badLines, 0)
    assert.equal(events.length, 1)
    assert.deepEqual(events[0], ev)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('seq continues across reopen', () => {
  const { dir, file } = tmpFile()
  try {
    const a = openLedger(file)
    assert.equal(a.append('a', { n: 1 }).seq, 1)
    assert.equal(a.append('b', { n: 2 }).seq, 2)
    assert.equal(a.append('c', { n: 3 }).seq, 3)
    const b = openLedger(file)
    assert.equal(b.append('d', { n: 4 }).seq, 4)
    assert.equal(b.append('e', { n: 5 }).seq, 5)
    const { events } = openLedger(file).readAll()
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4, 5])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('seq resumes from highest parseable line when tail is corrupt', () => {
  const { dir, file } = tmpFile()
  try {
    const a = openLedger(file)
    a.append('a', { n: 1 })
    a.append('b', { n: 2 })
    a.append('c', { n: 3 })
    writeFileSync(file, '\nnot json\n{also not json\n', { flag: 'a' })
    const b = openLedger(file)
    assert.equal(b.append('d', { n: 4 }).seq, 4)
    const { events, badLines } = b.readAll()
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4])
    assert.equal(badLines, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAll tolerates bad lines and never throws', () => {
  const { dir, file } = tmpFile()
  try {
    writeFileSync(file, '{"seq":1,"type":"ok"}\ngarbage\n{"seq":2,broken\n\n')
    const { events, badLines } = openLedger(file).readAll()
    assert.equal(badLines, 2)
    assert.equal(events.length, 1)
    assert.equal(events[0].seq, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('empty and missing files read as zero events', () => {
  const { dir, file } = tmpFile()
  try {
    writeFileSync(file, '')
    assert.deepEqual(openLedger(file).readAll(), { events: [], badLines: 0 })
    assert.deepEqual(openLedger(path.join(dir, 'absent.jsonl')).readAll(), { events: [], badLines: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('interleaved appends from two handles stay parseable', () => {
  const { dir, file } = tmpFile()
  try {
    const a = openLedger(file)
    const b = openLedger(file)
    const evA1 = a.append('run', { h: 'a' }, 't-a')
    const evB1 = b.append('run', { h: 'b' }, 't-b')
    const evA2 = a.append('run', { h: 'a' }, 't-a')
    const evB2 = b.append('run', { h: 'b' }, 't-b')
    const { events, badLines } = openLedger(file).readAll()
    assert.equal(badLines, 0)
    assert.equal(events.length, 4)
    assert.equal(a.count, 2)
    assert.equal(b.count, 2)
    assert.deepEqual(events.map(e => e.data.h), ['a', 'b', 'a', 'b'])
    assert.deepEqual(events[0], evA1)
    assert.deepEqual(events[1], evB1)
    assert.deepEqual(events[2], evA2)
    assert.deepEqual(events[3], evB2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('data and trialId default when omitted', () => {
  const { dir, file } = tmpFile()
  try {
    const ledger = openLedger(file)
    const ev = ledger.append('ping')
    assert.deepEqual(ev.data, {})
    assert.equal(ev.trialId, null)
    const { events } = ledger.readAll()
    assert.deepEqual(events[0], ev)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('count only tracks events written by this handle', () => {
  const { dir, file } = tmpFile()
  try {
    const a = openLedger(file)
    a.append('x')
    const b = openLedger(file)
    b.append('y')
    assert.equal(a.count, 1)
    assert.equal(b.count, 1)
    assert.equal(openLedger(file).count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
