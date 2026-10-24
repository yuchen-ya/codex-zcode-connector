import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export async function probeCdp(debugPort, timeoutMs = 3000) {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    })
    if (!response.ok) return { reachable: false, reason: `CDP HTTP ${response.status}` }
    const version = await response.json()
    const appVersion = /ZCode\/([\d.]+)/.exec(String(version['User-Agent'] ?? ''))?.[1]
    if (!appVersion) return { reachable: false, reason: 'The debug port is not served by ZCode' }
    return { reachable: true, appVersion }
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError || error.name === 'TimeoutError') {
      return { reachable: false, reason: 'ZCode debug endpoint unavailable or invalid' }
    }
    throw error
  }
}

function readLogTail(path) {
  let handle
  try {
    const size = statSync(path).size
    if (size === 0) return ''
    const length = Math.min(size, 8 * 1024 * 1024)
    const buffer = Buffer.alloc(length)
    handle = openSync(path, 'r')
    const read = readSync(handle, buffer, 0, length, size - length)
    return buffer.subarray(0, read).toString('utf8')
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null
    throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

function payloadFromLine(line) {
  const anchor = line.indexOf('"payload":')
  if (anchor < 0) return null
  const start = line.indexOf('{', anchor)
  if (start < 0) return null
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(line.slice(start, index + 1))
      } catch (error) {
        if (error instanceof SyntaxError) return null
        throw error
      }
    }
  }
  return null
}

export function readBalancesFromLog(home, now = new Date()) {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const text = readLogTail(join(home, 'v2', 'logs', `${stamp}.log`))
  if (text === null) return null
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('billing/balance')) continue
    const payload = payloadFromLine(line)
    if (!Array.isArray(payload?.data?.balances)) continue
    const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
    const balances = payload.data.balances.map(bucket => ({
      totalUnits: number(bucket.total_units), usedUnits: number(bucket.used_units),
      remainingUnits: number(bucket.remaining_units), availableUnits: number(bucket.available_units),
      expiresAt: number(bucket.expires_at),
      unitType: /^[A-Za-z_]{1,20}$/.test(bucket.unit_type ?? '') ? bucket.unit_type : null,
    }))
    if (balances.length) return { source: 'client-log', observedAt: /^\[([^\]]+)\]/.exec(line)?.[1] ?? null, balances }
  }
  return null
}

export async function collectStatus(config, { quota = false } = {}) {
  return {
    cdp: await probeCdp(config.debugPort), workspaceConfigured: true,
    ...(quota ? { quota: readBalancesFromLog(config.home) ?? { source: 'unavailable', balances: [] } } : {}),
  }
}
