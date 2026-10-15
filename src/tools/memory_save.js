import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

export function toSafeName(title) {
    let name = String(title ?? '')
        .replace(/^(记一下|保存|存起来|记住|记录)[：:\s]*/, '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '')
        .trim()
    if (!name) name = '未命名'
    if (WIN_RESERVED.test(name)) name = `_${name}`
    if (Buffer.byteLength(name, 'utf-8') > 100) {
        name = Buffer.from(name, 'utf-8').subarray(0, 100).toString('utf-8')
        name = name.replace(/\uFFFD$/, '')
    }
    return name
}

export function oneLine(s) {
    return String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
}

export function normalizeBody(s) {
    return String(s ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+$/, '')
}

/** 在 baseDir 下找一个不冲突的文件路径：base.txt → base-2.txt → base-3.txt ... */
export async function uniquePath(baseDir, base, ext) {
    let p = path.join(baseDir, `${base}${ext}`)
    let i = 2
    while (true) {
        try {
            await fs.access(p)
            p = path.join(baseDir, `${base}-${i}${ext}`)
            i++
        } catch {
            return p
        }
    }
}

export function makeMemorySaveTool({ ctx, subdir = '记忆', fallbackWorkspace } = {}) {
    return defineTool({
        name: 'memory_save',
        description: `把内容保存到工作区的记忆目录。
【什么时候必须调用】不要凭"值不值得"的感觉判断，改成按清单执行 —— 本轮只要出现下面任意一条就存：
① 新结论（分析或推理得出的明确判断）
② 新决定（方案选择、优先级、排期、取舍）
③ 新事实 / 数据 / 定义 / 术语
④ 新约束或规则（约定、格式、边界、不能做的事）
⑤ 用户纠正了你（含推翻既有结论）
⑥ 你纠正了自己的错误（含定位出的根因）

【每轮回答末尾必须报告一行记忆状态】——这是写给用户看的一行字，不是工具调用：
- 存了：本轮记忆：已存 <标题>
- 没存：本轮记忆：未存（原因）
漏报等于漏存：用户看不到这一行，就无从发现漏存。

【保存规则】
- 原样保存，不整理，不改格式（用户的原话必须原样保留）
- 只保存有实质内容的部分，不保存寒暄、确认、过渡语
- 纯闲聊、纯确认、只有工具执行结果而没有新结论时不要调用

用户说"记一下""保存""存起来"时无条件调用，即使你认为不值得存。`,

        parameters: {
            title: {
                type: 'string',
                required: true,
                description: '标题。5-15 字，概括主题，不要包含"记一下""保存""记忆"等指令词，不要带标点'
            },
            content: {
                type: 'string',
                required: true,
                description: '要保存的原始内容'
            },
            source: {
                type: 'string',
                description: '来源，可选。比如"对话""用户输入""外部资料"'
            }
        },

        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }]
        },

        async execute(args, exec) {
            // 只打印安全字段。exec.agent.ctx 是 Cordis 的 Context 代理：
            // 对 exec 整体做 JSON.stringify 会递归到代理上取 toJSON，抛
            // cannot get property "toJSON" without inject（且发生在 try 之外）
            try {
                console.log('[memory_save] exec 摘要 =', JSON.stringify({
                    callId: exec?.callId,
                    rootCallId: exec?.rootCallId,
                    name: exec?.name,
                    sessionId: exec?.agent?.id
                }))
            } catch (err) {
                console.warn('[memory_save] 打印 exec 摘要失败：', err?.message ?? err)
            }

            try {
                const { title, content, source } = args ?? {}
                if (!title || !content) {
                    return '保存失败：title 和 content 都不能为空'
                }

                // 1. 从 exec.agent 取当前会话的工作目录
                //    ToolRunContext 上没有 sessionId，会话就挂在 exec.agent.session 上
                let cwd = null
                try {
                    cwd = exec?.agent?.session?.header?.cwd ?? null
                } catch (err) {
                    console.warn('[memory_save] 读取 agent.session 失败：', err?.message ?? err)
                }

                // 2. 兜底：按 sessionId 查 ctx.sessions
                //    用 ctx.get(...) 而不是 ctx.sessions：插件 inject 只声明了 tools，
                //    属性直取会抛 cannot get property "sessions" without inject
                if (!cwd) {
                    let sessionId = null
                    try {
                        sessionId = exec?.agent?.id ?? exec?.sessionId ?? null
                    } catch (err) {
                        console.warn('[memory_save] 读取 exec 失败：', err?.message ?? err)
                    }
                    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
                    if (sessionId && sessions?.get) {
                        try {
                            const session = await sessions.get(sessionId)
                            cwd = session?.header?.cwd ?? session?.meta?.cwd ?? null
                        } catch (err) {
                            console.warn('[memory_save] 读取会话失败：', err?.message ?? err)
                        }
                    }
                }

                // 3. 通过 workspaceRegistry 解析工作区路径
                //    resolveByPath 是异步方法，应用 realpath 规范化
                const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
                let wsPath = null
                if (cwd && registry?.resolveByPath) {
                    try {
                        const ws = await registry.resolveByPath(cwd)
                        wsPath = ws?.path ?? null
                    } catch (err) {
                        console.warn('[memory_save] resolveByPath 失败：', err?.message ?? err)
                    }
                }

                // 4. 回退链：workspaceRegistry → cwd → 配置 → process.cwd()
                const basePath = wsPath ?? cwd ?? fallbackWorkspace ?? process.cwd()
                if (!path.isAbsolute(basePath)) {
                    return `保存失败：无法解析有效工作区路径（${basePath}）`
                }

                const baseDir = path.join(basePath, subdir)
                await fs.mkdir(baseDir, { recursive: true })

                const safe = toSafeName(title)
                const now = new Date()

                // 2026-10-09T09:28:00.462Z → 20261009-092800
                const iso = now.toISOString()
                const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`

                const filePath = await uniquePath(baseDir, `${safe}_${stamp}`, '.txt')

                let head = `# ${oneLine(title)}\n\n`
                head += `时间：${now.toISOString()}\n`
                if (source) head += `来源：${oneLine(source)}\n`
                head += `\n`

                const body = head + normalizeBody(content) + '\n'

                const tmpPath = `${filePath}.tmp`
                await fs.writeFile(tmpPath, body, 'utf-8')
                await fs.rename(tmpPath, filePath)

                return `已保存记忆：${path.relative(basePath, filePath)}`
            } catch (err) {
                return `保存失败：${err?.message ?? err}`
            }
        }
    })
}

/**
 * 漏存防线：订阅 session/event，在 turn 结束时检查本轮有没有调用过 memory_save。
 * 有实质输出却整轮没调用时，往 <工作区>/记忆/_待补.md 追加一行。
 *
 * 只能发现"整轮漏存"，发现不了"存得太少 / 存错"——那部分靠工具描述里的六条清单
 * 和"每轮报告记忆状态"兜。它也不会区分 memory_save 是否执行成功（只看有没有调用）。
 */
export function registerTurnMemoryCheck(ctx, { subdir = '记忆', minChars = 200 } = {}) {
    if (typeof ctx?.on !== 'function') return
    /** sessionId → { turn, saved, chars } */
    const states = new Map()

    ctx.on('session/event', (session, event) => {
        try {
            const id = session?.id
            const type = event?.type
            if (!id || !type) return

            let state = states.get(id)
            if (!state) {
                state = { turn: 0, saved: false, chars: 0 }
                states.set(id, state)
            }

            if (type === 'turn/start') {
                state.turn = event.data?.turn ?? state.turn + 1
                state.saved = false
                state.chars = 0
                return
            }

            if (type === 'tool/call') {
                if (event.data?.name === 'memory_save') state.saved = true
                return
            }

            if (type === 'assistant/message') {
                state.chars += assistantTextLength(event.data?.message)
                return
            }

            if (type === 'turn/end') {
                if (event.data?.reason?.kind !== 'completed') return   // 中断/出错/阻塞不算漏
                if (state.saved || state.chars < minChars) return
                const pending = { turn: state.turn, chars: state.chars }
                state.saved = true   // 同一轮只记一次
                void appendPending(session, pending, subdir)
            }
        } catch (err) {
            console.warn('[memory-check] 检查失败：', err?.message ?? err)
        }
    })
}

/** 累加一条 assistant/message 的可见文本长度（块数组 / 字符串都容错） */
function assistantTextLength(message) {
    const content = message?.content
    if (typeof content === 'string') return content.length
    if (!Array.isArray(content)) return 0
    let n = 0
    for (const block of content) {
        if (typeof block === 'string') n += block.length
        else if (typeof block?.text === 'string') n += block.text.length
        else if (typeof block?.content === 'string') n += block.content.length
    }
    return n
}

/** 把"本轮漏存"追加到 <工作区>/记忆/_待补.md */
async function appendPending(session, { turn, chars }, subdir) {
    try {
        const cwd = session?.header?.cwd
        if (!cwd || !path.isAbsolute(cwd)) return
        const dir = path.join(cwd, subdir)
        await fs.mkdir(dir, { recursive: true })

        const file = path.join(dir, '_待补.md')
        const line = `- ${new Date().toISOString()}｜轮次 ${turn}｜约 ${chars} 字｜会话 ${session.id}：本轮有实质输出但没保存记忆\n`

        let exists = true
        try {
            await fs.access(file)
        } catch {
            exists = false
        }

        if (exists) {
            await fs.appendFile(file, line, 'utf-8')
        } else {
            const head = '# 待补记忆\n\n'
                + '> 插件自动追加：这些轮次出现了实质内容却没有调用 memory_save。\n'
                + '> 补存（或确认不需要存）之后，把对应行删掉。\n\n'
            await fs.writeFile(file, head + line, 'utf-8')
        }
    } catch (err) {
        console.warn('[memory-check] 写入 _待补.md 失败：', err?.message ?? err)
    }
}