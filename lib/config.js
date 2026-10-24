import { homedir, tmpdir, platform } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))

export function loadConfig(env = process.env) {
  const debugPort = Number(env.ZCODE_DEBUG_PORT ?? 9333)
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw new Error('ZCODE_DEBUG_PORT must be an integer from 1 to 65535')
  }
  const stateBase = platform() === 'win32' ? (env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')) : (env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'))
  const stateDir = env.ZCODE_STATE_DIR ?? join(stateBase, 'codex-zcode-connector')
  if (!isAbsolute(stateDir)) throw new Error('ZCODE_STATE_DIR must be an absolute path')
  const workspace = env.ZCODE_WORKSPACE
  if (workspace !== undefined && !isAbsolute(workspace)) throw new Error('ZCODE_WORKSPACE must be an absolute path')
  const home = env.ZCODE_HOME ?? join(homedir(), '.zcode')
  if (!isAbsolute(home)) throw new Error('ZCODE_HOME must be an absolute path')
  return {
    debugPort,
    workspace: workspace === undefined ? null : resolve(workspace),
    home: resolve(home),
    stateDir: resolve(stateDir),
    tasksDir: join(resolve(stateDir), 'tasks'),
    profileDir: join(resolve(stateDir), 'profile'),
    replyTimeoutMs: 240_000,
    lockPath: join(tmpdir(), `codex-zcode-${debugPort}.lock`),
  }
}
