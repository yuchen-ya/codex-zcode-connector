import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { loadConfig } from '../lib/config.js'

const config = loadConfig()
if (!config.workspace) throw new Error('Specify --workspace ABSOLUTE_PATH or ZCODE_WORKSPACE before launching ZCode')
if (!statSync(config.workspace).isDirectory()) throw new Error('Workspace must be an existing directory')
const executable = process.env.ZCODE_EXE ?? join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'ZCode.exe')
if (!existsSync(executable)) throw new Error(`ZCode executable not found: ${executable}. Set ZCODE_EXE for a custom installation.`)
const occupied = await new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port: config.debugPort })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', error => { error.code === 'ECONNREFUSED' ? resolve(false) : reject(error) })
})
if (occupied) throw new Error(`Port ${config.debugPort} is already in use. Close the old debug instance explicitly or select another ZCODE_DEBUG_PORT.`)

const profile = config.profileDir
mkdirSync(profile, { recursive: true })
const child = spawn(executable, [
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${config.debugPort}`,
  `--open-workspace=${config.workspace}`,
], {
  cwd: config.workspace,
  env: { ...process.env, ZCODE_DESKTOP_USER_DATA_DIR: profile },
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
})
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
child.unref()
const deadline = Date.now() + 15_000
let ready = false
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}`)
    const version = await response.json()
    if (!String(version['User-Agent']).includes('ZCode/')) throw new Error('Debug port is not served by ZCode')
    ready = true
    break
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED' && error.name !== 'TimeoutError') throw error
  }
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (!ready) throw new Error('ZCode did not open its debug port within 15 seconds. Check the test instance before trying again.')
console.log(`ZCode ready on 127.0.0.1:${config.debugPort}`)
console.log(`Workspace: ${config.workspace}`)
console.log(`Desktop profile: ${profile}`)
