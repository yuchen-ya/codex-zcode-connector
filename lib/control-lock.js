import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'

// Codex can launch one MCP process per chat. An exclusive file keeps all of
// those processes from typing into the same ZCode composer simultaneously.
export async function withComposerLock(path, task) {
  let handle
  try {
    handle = openSync(path, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`ZCode composer is locked by another connector. Lock: ${path}. If a connector crashed, verify that its PID is no longer running before removing this file.`)
    }
    throw error
  }

  let released = false
  const release = () => {
    if (released) return
    released = true
    closeSync(handle)
    unlinkSync(path)
  }
  process.once('exit', release)
  try {
    writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    return await task()
  } finally {
    process.removeListener('exit', release)
    release()
  }
}
