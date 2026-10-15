import fs from 'node:fs/promises'
import path from 'node:path'
import { toSafeName, oneLine, normalizeBody, uniquePath } from './tools/memory_save.js'

/**
 * 两条用户主动保存的斜杠命令，与界面上的「保存为记忆」按钮共用同一套写入逻辑。
 *
 *   /save                        → 保存最近一条助手回答，标题自动取首行
 *   /save 标题                    → 以「标题」命名保存最近一条助手回答
 *   /save 长正文…（>50 字或含换行）  → 直接保存这段正文
 *   /save-memory <messageId>      → 按消息 id 精确保存某一条（界面按钮调用）
 *
 * recordInput: false —— 正文可能几千字，记忆文件本身就是唯一数据源，
 * 不再把 rawInput 抄进会话日志。不影响 handler 收到 rawInput。
 *
 * 注意：invocation 上只有 { commandId, agent, rawInput, signal }，
 * 没有 session —— 会话必须从 invocation.agent.session 取。
 */

export function registerSaveCommand(ctx, { subdir = '记忆' } = {}) {
    ctx.commands?.register({
        name: 'save',
        description: '把最近一条回答保存为记忆',
        input: { hint: '[标题 或 要保存的正文]' },
        recordInput: false,
        handler: (invocation) => runSave(invocation, { ctx, subdir })
    })
}

export function registerSaveMemoryCommand(ctx, { subdir = '记忆' } = {}) {
    ctx.commands?.register({
        name: 'save-memory',
        description: '把指定的一条助手消息保存为记忆（界面按钮调用）',
        input: { hint: '<messageId>' },
        recordInput: false,
        handler: (invocation) => runSaveByMessageId(invocation, { ctx, subdir })
    })
}

/** 会话挂在 agent 上；exec/agent 是 Cordis 代理，取属性要包 try */
function agentSession(invocation) {
    try {
        return invocation?.agent?.session ?? null
    } catch (err) {
        console.warn('[save] 读取 agent.session 失败：', err?.message ?? err)
        return null
    }
}

/** 工作区根：cwd → workspaceRegistry → cwd 兜底（与 memory_save 同一条链） */
async function resolveBasePath(ctx, session) {
    const cwd = session?.header?.cwd ?? null
    if (!cwd) return null

    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry?.resolveByPath) {
        try {
            const ws = await registry.resolveByPath(cwd)
            if (ws?.path) return ws.path
        } catch (err) {
            console.warn('[save] resolveByPath 失败：', err?.message ?? err)
        }
    }
    return cwd
}

/** 把一条 AssistantMessage 的文本块拼成纯文本 */
function textOf(message) {
    const content = message?.content
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    let out = ''
    for (const block of content) {
        if (typeof block === 'string') out += block
        else if (typeof block?.text === 'string') out += block.text
    }
    return out.trim()
}

/**
 * 会话事件流里最近一条有文本的 assistant/message。
 * 事件结构：{ type: 'assistant/message', data: { turn, step, message } }，
 * message.id 就是界面 slot 传来的 messageId。
 */
function lastAssistantText(session, messageId = null) {
    const events = Array.isArray(session?.events) ? session.events : []
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event?.type !== 'assistant/message') continue
        const message = event.data?.message
        if (messageId !== null && message?.id !== messageId) continue
        const text = textOf(message)
        if (text.length > 0) return text
    }
    return ''
}

/** 从正文首行造标题：去 markdown 记号，截 30 字 */
function autoTitle(text) {
    const lines = String(text ?? '').split('\n')
    let first = ''
    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length > 0) {
            first = trimmed
            break
        }
    }
    const clean = first.replace(/^#+\s*/, '').replace(/[#*_>]/g, '').trim()
    if (clean.length === 0) return '未命名'
    return clean.length > 30 ? clean.slice(0, 30) : clean
}

/** 共用写入：模型工具 / 两条命令 / 界面按钮 命名与格式完全一致 */
async function writeMemory({ basePath, subdir, title, content, source }) {
    const baseDir = path.join(basePath, subdir)
    await fs.mkdir(baseDir, { recursive: true })

    const safe = toSafeName(title)
    const now = new Date()
    const iso = now.toISOString()
    const stamp = iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '')
    const filePath = await uniquePath(baseDir, safe + '_' + stamp, '.txt')

    let body = '# ' + oneLine(title) + '\n\n'
    body += '时间：' + iso + '\n'
    body += '来源：' + source + '\n\n'
    body += normalizeBody(content) + '\n'

    const tmpPath = filePath + '.tmp'
    await fs.writeFile(tmpPath, body, 'utf-8')
    await fs.rename(tmpPath, filePath)

    return '已保存记忆：' + path.relative(basePath, filePath)
}

async function runSave(invocation, { ctx, subdir }) {
    try {
        const rawInput = String(invocation?.rawInput ?? '').trim()
        const session = agentSession(invocation)
        const basePath = await resolveBasePath(ctx, session)
        if (!basePath || !path.isAbsolute(basePath)) {
            return { kind: 'error', text: '保存失败：无法解析工作区路径' }
        }

        let title = ''
        let content = ''
        if (rawInput.includes('\n') || rawInput.length > 50) {
            content = rawInput
            title = autoTitle(rawInput)
        } else if (rawInput.length > 0) {
            title = rawInput
            content = lastAssistantText(session)
        } else {
            content = lastAssistantText(session)
            title = autoTitle(content)
        }

        if (content.length === 0) {
            return { kind: 'error', text: '保存失败：没有可保存的内容（最近没有助手回答，也没给正文）' }
        }

        const text = await writeMemory({ basePath, subdir, title, content, source: '/save 命令' })
        return { kind: 'success', text }
    } catch (err) {
        return { kind: 'error', text: '保存失败：' + (err?.message ?? err) }
    }
}

async function runSaveByMessageId(invocation, { ctx, subdir }) {
    try {
        const messageId = String(invocation?.rawInput ?? '').trim()
        if (messageId.length === 0) return { kind: 'error', text: '保存失败：缺少 messageId' }

        const session = agentSession(invocation)
        const basePath = await resolveBasePath(ctx, session)
        if (!basePath || !path.isAbsolute(basePath)) {
            return { kind: 'error', text: '保存失败：无法解析工作区路径' }
        }

        const content = lastAssistantText(session, messageId)
        if (content.length === 0) {
            return { kind: 'error', text: '保存失败：找不到消息 ' + messageId + '（或该消息没有文本）' }
        }

        const text = await writeMemory({ basePath, subdir, title: autoTitle(content), content, source: '界面按钮' })
        return { kind: 'success', text }
    } catch (err) {
        return { kind: 'error', text: '保存失败：' + (err?.message ?? err) }
    }
}
