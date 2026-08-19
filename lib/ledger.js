import { mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'

export function openLedger (filePath) {
  let nextSeq = 1
  let written = 0
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    text = ''
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof ev.seq === 'number' && ev.seq >= nextSeq) nextSeq = ev.seq + 1
  }
  const append = (type, data = {}, trialId = null) => {
    const event = {
      seq: nextSeq,
      ts: new Date().toISOString(),
      schemaVersion: '1',
      trialId,
      type,
      data
    }
    mkdirSync(path.dirname(filePath), { recursive: true })
    appendFileSync(filePath, JSON.stringify(event) + '\n')
    nextSeq += 1
    written += 1
    return event
  }
  const readAll = () => {
    let raw
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { events: [], badLines: 0 }
      throw err
    }
    const events = []
    let badLines = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        badLines += 1
      }
    }
    return { events, badLines }
  }
  return {
    path: filePath,
    append,
    readAll,
    get count () {
      return written
    }
  }
}
