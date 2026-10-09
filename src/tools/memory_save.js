import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

function toSafeName(title) {
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

function oneLine(s) {
    return String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
}

function normalizeBody(s) {
    return String(s ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+$/, '')
}

/** 在 baseDir 下找一个不冲突的文件路径：base.txt → base-2.txt → base-3.txt ... */
async function uniquePath(baseDir, base, ext) {
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
        description: `把内容保存到工作区的记忆目录。每次回答完，如果这次对话产生了值得保留的内容，就调用它。

保存规则：
- 原样保存，不整理，不改格式
- 只保存有实质内容的部分，不保存寒暄、确认、过渡语
- 如果这次回答只是闲聊、确认、没有新内容，不要调用

用户说"记一下""保存""存起来"，或者 AI 判断这次回答有值得保留的内容时调用。`,

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