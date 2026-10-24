import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { withComposerLock } from './control-lock.js'
import { resolveModelSelection } from './model-options.js'

const MIN_VIEWPORT = { width: 640, height: 480 }
let lastUsableViewport = null
const SAMPLE_INTERVAL_MS = 1200

// ─────────────────────────────── CDP 通道 ───────────────────────────────
async function attach(config) {
  const response = await fetch(`http://127.0.0.1:${config.debugPort}/json/list`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
  if (!response.ok) throw new Error(`ZCode CDP returned HTTP ${response.status}`)
  const targets = await response.json()
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('renderer/index.html'))
  if (pages.length !== 1) throw new Error(`Expected one ZCode renderer on CDP ${config.debugPort}, found ${pages.length}`)
  const page = pages[0]

  const socketUrl = new URL(page.webSocketDebuggerUrl)
  if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== '127.0.0.1' || Number(socketUrl.port) !== config.debugPort) {
    throw new Error('ZCode debugger must use the configured loopback port')
  }
  const socket = new WebSocket(socketUrl)
  const pending = new Map()
  let nextId = 0
  let closedReason = null

  // Settle outstanding commands when the renderer exits or reloads.
  const failAll = (reason) => {
    closedReason = closedReason ?? reason
    for (const [, { reject, timer }] of pending) {
      clearTimeout(timer)
      reject(new Error(closedReason))
    }
    pending.clear()
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')) }, 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }, { once: true })
  })
  socket.addEventListener('close', () => failAll('CDP 连接已断开（ZCode 退出或页面重载）'))
  socket.addEventListener('error', () => failAll('CDP 连接出错'))
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject, timer } = pending.get(message.id)
    clearTimeout(timer)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  })
  // A send on a CLOSED WebSocket is silently discarded by spec (it does not throw), which would
  // leave the promise below pending forever — so the readyState has to be checked explicitly.
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (closedReason !== null) return reject(new Error(closedReason))
    if (socket.readyState !== 1) return reject(new Error(`CDP 连接不可用（readyState ${socket.readyState}）`))
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP command timed out: ${method}`))
    }, 10_000)
    pending.set(id, { resolve, reject, timer })
    try {
      socket.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(new Error(`CDP 发送失败: ${error.message}`))
    }
  })
  return { send, close: () => { failAll('CDP session closed'); socket.close() } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(description.split('\n')[0])
  }
  return result.result.value
}

async function waitForPage(cdp, expression, what) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression)
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ZCode UI: ${what}`)
}

/** Freeze the current layout while measuring and clicking page controls. */
async function freezeViewport(cdp) {
  const current = await evaluate(cdp, '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })')
  const usable = current !== null
    && Number.isFinite(current.w) && Number.isFinite(current.h)
    && current.w >= MIN_VIEWPORT.width && current.h >= MIN_VIEWPORT.height
  if (usable) {
    lastUsableViewport = { width: Math.round(current.w), height: Math.round(current.h), dpr: Number.isFinite(current.dpr) && current.dpr > 0 ? current.dpr : 1 }
  }
  // A minimized window may report no size; reuse only an observed real viewport.
  const target = lastUsableViewport
  if (target === null) return { width: null, height: null, deviceScaleFactor: null, source: 'none' }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: target.width, height: target.height, deviceScaleFactor: target.dpr, mobile: false })
  return { width: target.width, height: target.height, dpr: target.dpr, deviceScaleFactor: target.dpr, source: usable ? 'window' : 'last-window' }
}

/** Release renderer-only emulation. Safe when the session is already gone. */
async function releaseViewport(cdp) {
  try {
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  } catch {
    /* the session is closing anyway */
  }
}

async function clickPoint(cdp, x, y) {
  const point = { x, y, button: 'left', clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
}

/**
 * 定位 → 校验 → 点击。校验两件事，任一不过就抛错（不盲点）：
 *   1. 稳定性：120ms 后同一个元素的 bounding box 不变（排除动画/布局漂移）
 *   2. 命中：document.elementFromPoint(中心) 落在该元素自身或其子孙上（排除被遮挡/坐标偏）
 * 这是"用脚本检测位置对不对"的那一步；仅靠 querySelector 拿坐标是不够的。
 */
async function locate(cdp, queryBody, what) {
  const raw = await waitForPage(cdp, `(() => {
    ${FIND_HELPERS}
    const el = (() => { ${queryBody} })();
    if (!visible(el)) return null;
    if (el.matches(':disabled,[aria-disabled="true"]') || (el.hasAttribute('data-disabled') && el.getAttribute('data-disabled') !== 'false')) throw new Error('Control is disabled');
    el.setAttribute('data-zc-target', '1');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: textOf(el).slice(0, 60) });
  })()`, what)
  const box = JSON.parse(raw)
  await sleep(120)
  const check = await evaluate(cdp, `(() => {
    const el = document.querySelector('[data-zc-target="1"]');
    if (!el) return JSON.stringify({ ok: false, why: '元素消失' });
    const r = el.getBoundingClientRect();
    const stable = Math.abs(r.x - ${box.x}) < 1 && Math.abs(r.y - ${box.y}) < 1;
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const onTarget = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    return JSON.stringify({ ok: stable && onTarget, stable, onTarget, cx, cy, hitTag: hit ? hit.tagName : null });
  })()`)
  const verdict = JSON.parse(check)
  await evaluate(cdp, `(() => { const el = document.querySelector('[data-zc-target="1"]'); if (el) el.removeAttribute('data-zc-target'); return true; })()`)
  if (!verdict.ok) throw new Error(`点击前校验未通过（${what}）: 稳定=${verdict.stable} 命中=${verdict.onTarget} 命中元素=${verdict.hitTag}`)
  return { centre: { x: verdict.cx, y: verdict.cy }, text: box.text }
}

async function clickBy(cdp, queryBody, what) {
  const found = await locate(cdp, queryBody, what)
  await clickPoint(cdp, found.centre.x, found.centre.y)
  return found
}

// Activate the real menu item's click handler without pointer hover changing
// the provider submenu while the Electron window is minimized.
async function activateMenuItem(cdp, queryBody, what) {
  await locate(cdp, queryBody, what)
  await evaluate(cdp, `(() => {
    ${FIND_HELPERS}
    const el = (() => { ${queryBody} })();
    el.click();
    return true;
  })()`)
}

const FIND_HELPERS = `
  const visible = (el) => Boolean(el && el.offsetParent !== null && el.getClientRects().length > 0);
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const centreOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
`

// Verified against ZCode 3.16.3. Inspect the composer's explicit provider/model
// marker: the visible model label alone does not identify the billing channel.
async function readModelConfig(cdp) {
  return evaluate(cdp, `(() => {
    const el = document.querySelector('[data-testid="v4-model-config"][data-source="composer"]');
    if (!el) throw new Error('ZCode model configuration marker unavailable');
    return { provider: el.dataset.provider, model: el.dataset.model, effort: el.dataset.thought, effortLevels: el.dataset.thoughtLevels.split(',') };
  })()`)
}

async function readModelCatalog(cdp) {
  return evaluate(cdp, `(() => {
    const el = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!el) throw new Error('ZCode model selector unavailable');
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      const groups = fiber.memoizedProps?.modelGroups;
      if (Array.isArray(groups)) return groups.filter(g => g.key.startsWith('registry-provider:')).map(g => ({
        id: g.key.slice('registry-provider:'.length), key: g.key, label: g.label, badge: g.labelBadge,
        models: g.items.map(item => ({ id: item.name, value: item.value, vision: item.supportsVisionInput === true }))
      }));
    }
    throw new Error('ZCode model catalog unavailable');
  })()`)
}

async function pressKey(cdp, key, code, windowsVirtualKeyCode) {
  const params = { key, code, windowsVirtualKeyCode }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function closeModelMenu(cdp) {
  for (let i = 0; i < 2; i++) {
    const open = await evaluate(cdp, `Boolean(document.querySelector('[role="menu"][data-state="open"] [data-testid="composer-provider-trigger"]'))`)
    if (!open) return
    const count = await evaluate(cdp, `document.querySelectorAll('[role="menu"][data-state="open"]').length`)
    await pressKey(cdp, 'Escape', 'Escape', 27)
    await waitForPage(cdp, `document.querySelectorAll('[role="menu"][data-state="open"]').length < ${count}`, 'model menu to close')
  }
}

async function waitForModelConfig(cdp, selection, checkEffort = false) {
  await waitForPage(cdp, `(() => {
    const el = document.querySelector('[data-testid="v4-model-config"][data-source="composer"]');
    return el && el.dataset.provider === ${JSON.stringify(selection.provider)}
      && el.dataset.model === ${JSON.stringify(selection.model)}
      && (${!checkEffort} || el.dataset.thought === ${JSON.stringify(selection.effort)});
  })()`, 'selected model configuration')
}

async function applyModelSelection(cdp, selection) {
  const current = await readModelConfig(cdp)
  if (current.provider === selection.provider && current.model === selection.model && current.effort === selection.effort) return current
  await closeModelMenu(cdp)
  await clickBy(cdp, `return document.querySelector('[data-testid="chat-model-select-trigger"]');`, '模型选择器')
  await sleep(400)
  try {
    if (current.provider !== selection.provider) {
      await clickBy(cdp, `return document.querySelector('[data-testid="composer-provider-trigger"]');`, '供应商选择器')
      await sleep(300)
      await activateMenuItem(cdp, `return [...document.querySelectorAll('[role="menuitemradio"][data-model-provider-key]')]
        .find(e => e.getAttribute('data-model-provider-key') === ${JSON.stringify(selection.providerKey)});`, selection.provider)
      await waitForPage(cdp, `document.querySelector('[data-testid="v4-model-config"][data-source="composer"]')?.dataset.provider === ${JSON.stringify(selection.provider)}`, 'selected provider')
    }
    await activateMenuItem(cdp, `return [...document.querySelectorAll('[role="menuitemradio"][data-testid]')]
      .find(e => e.getAttribute('data-testid') === ${JSON.stringify('chat-model-select-item-' + selection.modelValue)});`, selection.model)
    await waitForModelConfig(cdp, selection)
    const afterModel = await readModelConfig(cdp)
    const effortIndex = afterModel.effortLevels.indexOf(selection.effort)
    if (effortIndex === -1) throw new Error(`Thinking effort ${selection.effort} is unavailable for ${selection.model}`)
    if (afterModel.effort !== selection.effort) {
      const focused = await evaluate(cdp, `(() => {
        const slider = document.querySelector('[data-testid="composer-thought-slider"]');
        if (!slider || slider.getAttribute('aria-disabled') === 'true') return false;
        slider.focus();
        return document.activeElement === slider;
      })()`)
      if (!focused) throw new Error('ZCode thinking effort slider is unavailable')
      await pressKey(cdp, 'Home', 'Home', 36)
      for (let i = 0; i < effortIndex; i++) await pressKey(cdp, 'ArrowRight', 'ArrowRight', 39)
      await waitForModelConfig(cdp, selection, true)
    }
  } finally {
    await closeModelMenu(cdp)
  }
  const after = await readModelConfig(cdp)
  if (after.provider !== selection.provider || after.model !== selection.model || after.effort !== selection.effort) {
    throw new Error(`ZCode model selection failed. Expected ${JSON.stringify(selection)}, found ${JSON.stringify(after)}`)
  }
  return after
}

const WORKSPACE_CONTEXT = `
  const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
  if (!el) throw new Error('Workspace composer unavailable');
  let root = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))];
  let services, workspace, identity;
  for (let fiber = root; fiber; fiber = fiber.return) {
    const p = fiber.memoizedProps;
    if (workspace === undefined && typeof p?.workspacePath === 'string') { workspace = p.workspacePath; identity = p.workspaceIdentity; }
    if (p?.value?.projectService) services = p.value;
  }
  if (workspace === undefined || !services) throw new Error('Native workspace context unavailable');
  while (root.return) root = root.return;
  function findProps(fiber, predicate) {
    if (!fiber) return null;
    if (predicate(fiber.memoizedProps)) return fiber.memoizedProps;
    return findProps(fiber.child, predicate) || findProps(fiber.sibling, predicate);
  }
`

export async function listZCodeWorkspaces(config) {
  const cdp = await attach(config)
  try {
    const result = await evaluate(cdp, `(async () => {
      ${WORKSPACE_CONTEXT}
      const projects = await services.projectService.readProjects();
      return { current: { path: workspace, remote: Boolean(identity) }, workspaces: projects
        .filter(p => !p.deleted && p.hostId === 'local')
        .map(p => ({ id: p.id, name: p.name, path: p.roots.find(r => r.isPrimary)?.rootPath })) };
    })()`)
    result.workspaces = result.workspaces.map(item => {
      let available
      try { available = statSync(item.path).isDirectory() } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
        available = false
      }
      return { ...item, available, current: !result.current.remote && sameWorkspace(item.path, result.current.path) }
    })
    return result
  } finally { cdp.close() }
}

function sameWorkspace(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

async function assertWorkspace(cdp, expectedWorkspace) {
  const workspace = await evaluate(cdp, `(() => {
    ${WORKSPACE_CONTEXT}
    if (identity) throw new Error('Remote workspaces are not supported');
    return workspace;
  })()`)
  if (!sameWorkspace(workspace, expectedWorkspace)) {
    throw new Error(`Workspace mismatch: expected ${expectedWorkspace}, found ${workspace}`)
  }
}

async function prepareWorkspace(cdp, expectedWorkspace, fresh = false) {
  const shouldSwitch = await evaluate(cdp, `(async () => {
    ${WORKSPACE_CONTEXT}
    if (identity) throw new Error('Remote workspaces are not supported');
    const target = ${JSON.stringify(expectedWorkspace)};
    const normalize = path => { const value = path.replaceAll('\\\\', '/').toLowerCase(); return value.endsWith('/') ? value.slice(0, -1) : value; };
    const tree = await services.projectService.readTree();
    const project = tree.projects.find(p => !p.deleted && p.hostId === 'local' && p.roots.some(r => r.isPrimary && normalize(r.rootPath) === normalize(target)));
    if (!project) throw new Error('Workspace is not registered in ZCode. Open the project in ZCode first; use workspaces to list projects.');
    if (tree.tasks.some(t => t.hostId === 'local' && [normalize(workspace), normalize(target)].includes(normalize(t.workspacePath)) && (t.status === 'running' || t.pendingInteraction))) {
      throw new Error('Current or target workspace has a running task or pending input');
    }
    return normalize(workspace) !== normalize(target) || ${fresh};
  })()`)
  if (shouldSwitch) await evaluate(cdp, `(() => {
    ${WORKSPACE_CONTEXT}
    const props = findProps(root, p => typeof p?.handleStartDraftInWorkspace === 'function');
    if (!props) throw new Error('Native workspace switch unavailable');
    props.handleStartDraftInWorkspace(${JSON.stringify(expectedWorkspace)}, undefined, 'project');
    return true;
  })()`)
  await waitForPage(cdp, `(() => {
    ${WORKSPACE_CONTEXT}
    return !identity && workspace.replaceAll('\\\\', '/').toLowerCase() === ${JSON.stringify(expectedWorkspace.replaceAll('\\', '/').toLowerCase())}
      && (!${fresh} || document.querySelector('[data-testid="v4-session-pane-workspace-main"]')?.dataset.sessionId === 'draft');
  })()`, 'target workspace')
  await assertWorkspace(cdp, expectedWorkspace)
}

async function assertEmptyComposer(cdp) {
  await evaluate(cdp, `(() => {
    const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!el || el.innerText.trim()) throw new Error('Composer contains an unsent draft; preserve it in ZCode before starting a task');
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      const draft = fiber.memoizedProps?.composerDraft;
      if (draft && Array.isArray(draft.attachments) && draft.attachments.length) throw new Error('Composer contains draft attachments');
    }
  })()`)
}

async function typePrompt(cdp, text, workspace) {
  // Select whatever is already in the composer first: `Input.insertText` replaces the
  // selection, and without this the prompt is APPENDED to leftovers (measured: a stale
  // skill reference rode along with the prompt and the model echoed it back).
  const prepared = await evaluate(cdp, `(() => {
    ${FIND_HELPERS}
    const editor = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!editor) return 'no editor';
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.activeElement === editor ? 'ok' : 'not focused';
  })()`)
  if (prepared !== 'ok') throw new Error(`输入框准备失败: ${prepared}`)

  await assertWorkspace(cdp, workspace)
  await cdp.send('Input.insertText', { text })
  await sleep(300)

  // Verify what actually landed before committing to send.
  const landed = await evaluate(cdp, `(() => {
    const editor = document.querySelector('div[role="textbox"][contenteditable="true"]');
    return editor ? editor.innerText.replace(/\\s+/g, ' ').trim() : null;
  })()`)
  const wanted = text.replace(/\s+/g, ' ').trim()
  if (landed !== wanted) throw new Error(`输入框内容与预期不符: 期望 ${JSON.stringify(wanted.slice(0, 60))} 实际 ${JSON.stringify(String(landed).slice(0, 60))}`)

  await assertWorkspace(cdp, workspace)
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function readConversationState(cdp) {
  return evaluate(cdp, `(() => {
    const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
    if (!pane) throw new Error('ZCode conversation pane unavailable');
    if (pane.dataset.sessionId === 'draft') return { sessionId: 'draft', control: { canStop: false }, pendingInteractions: [] };
    const el = pane.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!el) throw new Error('Conversation composer unavailable');
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      const snapshot = fiber.memoizedProps?.snapshot;
      if (snapshot) return { sessionId: snapshot.sessionId, control: snapshot.control, pendingInteractions: snapshot.pendingInteractions,
        permission: { mode: snapshot.config.mode, label: document.querySelector('[data-testid="chat-mode-select-trigger"]')?.innerText ?? snapshot.config.mode } };
    }
    throw new Error('ZCode conversation snapshot unavailable');
  })()`)
}

/** Sizes of every session transcript, so a later read can tell which one is ours. */
function transcriptSizes(home) {
  const directory = join(home, 'cli', 'rollout')
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
  const sizes = new Map()
  for (const name of names) {
    if (!name.startsWith('model-io-') || !name.endsWith('.jsonl') || name.includes('subagent')) continue
    try {
      sizes.set(name, statSync(join(directory, name)).size)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error // The client rotates its transcript files.
    }
  }
  return sizes
}

/**
 * The assistant's final text for the turn, from ZCode's own per-request transcript.
 *
 * Records are `{querySource, request:{body}, response:{text, toolCalls}}`; the app writes its
 * own session-title request into the same file, so `querySource === 'main_turn'` is the filter
 * and the LAST such record is the merged answer (earlier ones are tool-calling rounds).
 */
export function readMainTurnAnswer(before, sessionId, home) {
  if (!/^(?:session|sess)_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid ZCode session ID')
  const name = `model-io-${sessionId}.jsonl`
  const path = join(home, 'cli', 'rollout', name)
  let content
  try {
    if (statSync(path).size <= (before.get(name) ?? 0)) return null
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let answer = null
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      if (error instanceof SyntaxError) continue // The client may still be appending the last line.
      throw error
    }
    if (record.querySource !== 'main_turn') continue
    answer = typeof record.response?.text === 'string' ? record.response.text.trim() || null : null
  }
  return answer
}

async function withIdleComposer(config, task) {
  if (!config.workspace) throw new Error('Workspace required: use --workspace ABSOLUTE_PATH or ZCODE_WORKSPACE; query workspaces first')
  return withComposerLock(config.lockPath, async () => {
    if (!statSync(config.workspace).isDirectory()) throw new Error('ZCODE_WORKSPACE must be a directory')
    const cdp = await attach(config)
    try {
      // Keep renderer focus for background menu/keyboard handling without
      // focusing, restoring, or sending input to the operating-system window.
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      const state = await readConversationState(cdp)
      if (state.control.canStop || state.pendingInteractions.length > 0) {
        throw new Error('ZCode is still working or awaiting input. Resolve the current task before changing its composer.')
      }
      await assertEmptyComposer(cdp)
      await prepareWorkspace(cdp, config.workspace)
      const targetState = await readConversationState(cdp)
      if (targetState.control.canStop || targetState.pendingInteractions.length) throw new Error('Target workspace is busy or awaiting input')
      await assertEmptyComposer(cdp)
      await freezeViewport(cdp)
      return await task(cdp)
    } finally {
      await releaseViewport(cdp)
      cdp.close()
    }
  })
}

export async function listZCodeModels(config) {
  const cdp = await attach(config)
  try {
    if (config.workspace) await assertWorkspace(cdp, config.workspace)
    return { current: await readModelConfig(cdp), providers: await readModelCatalog(cdp), permission: (await readConversationState(cdp)).permission }
  } finally {
    cdp.close()
  }
}

export async function selectZCodeModel(options, config) {
  return withIdleComposer(config, async cdp => {
    const selection = resolveModelSelection(await readModelCatalog(cdp), await readModelConfig(cdp), options)
    return await applyModelSelection(cdp, selection)
  })
}

export async function startZCodeTask(prompt, config, options = {}) {
  return withIdleComposer(config, async cdp => {
    // Capture the current choice before New task resets the draft to its defaults.
    const selection = resolveModelSelection(await readModelCatalog(cdp), await readModelConfig(cdp), options)
    await closeModelMenu(cdp)
    await prepareWorkspace(cdp, config.workspace, true)
    await assertWorkspace(cdp, config.workspace)
    const selected = await applyModelSelection(cdp, selection)
    const before = transcriptSizes(config.home)
    await assertWorkspace(cdp, config.workspace)
    await assertEmptyComposer(cdp)
    await typePrompt(cdp, prompt, config.workspace)
    const state = await waitForPage(cdp, `(() => {
      const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
      return pane?.dataset.sessionId && pane.dataset.sessionId !== 'draft' ? pane.dataset.sessionId : null;
    })()`, 'submitted task session')
    const conversation = await readConversationState(cdp)
    return { sessionId: state, before: [...before], provider: selected.provider, model: selected.model,
      effort: selected.effort, permission: conversation.permission }
  })
}

// Reuse the active pane's native transport and its established client identity.
// Only these two interaction commands are exposed; arbitrary native commands are not.
async function interactionCommand(cdp, sessionId, interactionId, type, answer) {
  if (!['resolveInteraction', 'snoozeInteractionAutoResolution'].includes(type)) throw new Error('Unsupported interaction command')
  const result = await evaluate(cdp, `(async () => {
    const el = document.querySelector('[data-testid="v4-session-pane-workspace-main"] div[role="textbox"][contenteditable="true"]');
    if (!el) throw new Error('Conversation composer unavailable');
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    let snapshot, transport;
    for (let fiber = el[key]; fiber; fiber = fiber.return) {
      if (!snapshot && fiber.memoizedProps?.snapshot) snapshot = fiber.memoizedProps.snapshot;
      if (!transport && typeof fiber.memoizedProps?.value?.sendCommand === 'function') transport = fiber.memoizedProps.value;
    }
    if (snapshot?.sessionId !== ${JSON.stringify(sessionId)}) throw new Error('ZCode conversation changed');
    if (!snapshot.pendingInteractions.some(i => i.interactionId === ${JSON.stringify(interactionId)})) throw new Error('Interaction is no longer pending');
    if (!transport) throw new Error('Native conversation transport unavailable');
    const clientId = localStorage.getItem('zcode-v4-client-id:v1');
    if (!clientId) throw new Error('Native conversation client identity unavailable');
    return transport.sendCommand({commandId: crypto.randomUUID(), clientId, sessionId: ${JSON.stringify(sessionId)},
      type: ${JSON.stringify(type)}, issuedAt: Date.now(), payload: {interactionId: ${JSON.stringify(interactionId)},
      ${type === 'resolveInteraction' ? `answer: ${JSON.stringify(answer)}` : ''}}});
  })()`)
  if (!['accepted', 'duplicate', 'noop'].includes(result.status)) throw new Error(`ZCode interaction rejected: ${result.status} ${result.reasonCode ?? ''}`)
  return result
}

export async function waitZCodeTask(task, config, timeoutMs) {
  const cdp = await attach(config)
  try {
    const deadline = Date.now() + timeoutMs
    while (true) {
      await assertWorkspace(cdp, config.workspace)
      const state = await readConversationState(cdp)
      if (state.sessionId !== task.sessionId) throw new Error('ZCode conversation changed; restore the delegated task before waiting or replying')
      if (state.pendingInteractions.length > 0) {
        for (const request of state.pendingInteractions) {
          if (request.autoResolution && request.autoResolution.state !== 'snoozed') {
            await interactionCommand(cdp, task.sessionId, request.interactionId, 'snoozeInteractionAutoResolution')
          }
        }
        return { status: 'needs_input', requests: (await readConversationState(cdp)).pendingInteractions, permission: state.permission }
      }
      if (state.control.lastError) return { status: 'failed', error: state.control.lastError }
      if (state.control.phase === 'completedInterrupted') return { status: 'interrupted' }
      if (state.control.phase === 'completedSuccess') {
        const reply = readMainTurnAnswer(new Map(task.before), task.sessionId, config.home)
        if (reply !== null) return { status: 'completed', reply }
      }
      if (Date.now() >= deadline) return { status: 'running' }
      await sleep(Math.min(SAMPLE_INTERVAL_MS, Math.max(0, deadline - Date.now())))
    }
  } finally {
    cdp.close()
  }
}

export async function replyZCodeTask(task, config, interactionId, answer) {
  return withComposerLock(config.lockPath, async () => {
    const cdp = await attach(config)
    try {
      await assertWorkspace(cdp, config.workspace)
      const state = await readConversationState(cdp)
      if (state.sessionId !== task.sessionId) throw new Error('ZCode conversation changed')
      const request = state.pendingInteractions.find(item => item.interactionId === interactionId)
      if (!request) throw new Error('Interaction is no longer pending')
      const { validateInteractionAnswer } = await import('./interactions.js')
      validateInteractionAnswer(request, answer)
      await interactionCommand(cdp, task.sessionId, interactionId, 'resolveInteraction', answer)
      return { status: 'running', answered: interactionId }
    } finally {
      cdp.close()
    }
  })
}
