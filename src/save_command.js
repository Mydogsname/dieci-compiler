import fs from 'node:fs/promises'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toSafeName, oneLine, normalizeBody, uniquePath } from './tools/memory_save.js'

/**
 * 一条用户主动保存的斜杠命令。
 *
 *   /save                        → 保存最近一条助手回答，标题自动取首行
 *   /save 标题                    → 以「标题」命名保存最近一条助手回答
 *   /save 长正文…（>50 字或含换行）  → 直接保存这段正文
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

/**
 * /dieci <主题> —— 建叠词文件骨架，并把「围绕主题成文」的活派给模型。
 *
 * 命令只做机械活：造文件名、写骨架、派任务。
 * 扫描与判断全交给模型自己的 find_sources / annotate —— 判据只留一份。
 *
 * recordInput: false —— 主题会写进骨架文件名，日志里不再抄一份。
 */
export function registerDieciCommand(ctx, { subdir = '记忆', ext = '.txt', commandName = 'dieci' } = {}) {
    ctx.commands?.register({
        name: commandName,
        description: '围绕一个主题建叠词文件，并让 AI 成文与补注释',
        input: { hint: '<主题>' },
        recordInput: false,
        handler: (invocation) => runDieci(invocation, { ctx, subdir, ext })
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
function lastAssistantText(session) {
    const events = Array.isArray(session?.events) ? session.events : []
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event?.type !== 'assistant/message') continue
        const text = textOf(event.data?.message)
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

/** 从用户输入取主题：取第一个非空行，去掉 markdown 记号，截 30 字 */
function parseTheme(rawInput) {
    const lines = String(rawInput ?? '').replace(/\r\n?/g, '\n').split('\n')
    let first = ''
    for (const line of lines) {
        const t = line.trim()
        if (t) { first = t; break }
    }
    const clean = first.replace(/^#+\s*/, '').replace(/[#*_>`]/g, '').trim()
    return clean.length > 30 ? clean.slice(0, 30) : clean
}

async function runDieci(invocation, { ctx, ext }) {
    try {
        const theme = parseTheme(invocation?.rawInput)
        if (!theme) {
            return { kind: 'error', text: '用法：/dieci <主题>　例如：/dieci 部署环境搭建' }
        }

        const session = agentSession(invocation)
        const basePath = await resolveBasePath(ctx, session)
        if (!basePath || !path.isAbsolute(basePath)) {
            return { kind: 'error', text: '建文件失败：无法解析工作区路径' }
        }

        await fs.mkdir(basePath, { recursive: true })

        // 文件名：主题 → 安全名；已存在就追加序号（不覆盖人的文件）
        const filePath = await uniquePath(basePath, toSafeName(theme), ext)
        const rel = path.relative(basePath, filePath).replace(/\\/g, '/')

        // 骨架：标题 / 空正文 / 「注释：」行。正文与注释都留给模型。
        const skeleton = oneLine(theme) + '\n\n\n注释：\n'
        const tmpPath = filePath + '.tmp'
        await fs.writeFile(tmpPath, skeleton, 'utf-8')
        await fs.rename(tmpPath, filePath)

        // 派活。文本只放"读哪些文件、干什么、不许干什么"，
        // 不放任何关系/注释内容 —— 关系属于文件，不属于消息。
        const task = [
            '【叠词：围绕主题成文】',
            `主题：${theme}`,
            `骨架已建好：${rel}（目前只有标题和一个「注释：」区标记，正文是空的）`,
            '',
            '请照下面四步做，顺序不要跳：',
            `1. 先调 find_sources，words 传能从主题拆出的关键词。看它的报告，不要凭印象写。`,
            `2. 起草正文。正文只做三件事：汇总已有材料、推演已有内容、把散落的线索组织成条理。`,
            '   不许发挥：不得引入材料里没有的事实、数字、结论。',
            '   凡是推断出来而非材料明写的部分，用一句话标注「（推演）」并写明推自哪一条。',
            `3. 写回 ${rel} 的正文段。格式照「叠词」：第 1 行标题，接着正文，最后是那行「注释：」。`,
            `4. 调 annotate 补注释。每条必须带 basis —— 指向材料写「记忆\\文件:行」，`,
            '   自指写「本文…」。没有依据的词宁可不写，annotate 会拒。',
            '',
            '做完把 annotate 的返回原样贴出来（尤其被拒/待补/未识别行三类）。',
        ].join('\n')

        try {
            invocation?.agent?.followup(
                createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })
            )
        } catch (err) {
            return {
                kind: 'error',
                text: `骨架已建好：${rel}\n但派任务给模型失败：${err?.message ?? err}`,
            }
        }

        return { kind: 'success', text: `已建 ${rel}，并已把成文任务派给模型` }
    } catch (err) {
        return { kind: 'error', text: '建文件失败：' + (err?.message ?? err) }
    }
}
