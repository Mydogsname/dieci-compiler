import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePrompt } from '../parse_prompt.js'

/** 取一行不超过 20 字的预览（含标点空格按原样截前 20 个字符，加省略号） */
function preview(line, max = 20) {
    const s = String(line ?? '')
    return s.length > max ? s.slice(0, max) + '…' : s
}

/** 段内行号区间（基于原始行号，1 起），全空段返回 null */
function lineSpan(lines, range, lines0) {
    if (!range) return null
    let first = range[0] + 1   // 1 起
    let last = range[1]        // slice 上界 = 最后非空行 + 1（或段末）
    // 找段内最后一个非空行（1 起行号）
    let lastNonBlank = -1
    for (let i = range[1] - 1; i >= range[0]; i--) {
        if (lines0[i].trim() !== '') { lastNonBlank = i + 1; break }
    }
    return { first, last: lastNonBlank > 0 ? lastNonBlank : first - 1 }
}

// ─── 工具工厂 ───
export function makeParsePromptTool({ ctx, fallbackWorkspace } = {}) {
    return defineTool({
        name: 'parse_prompt',
        description: `看一个叠词文件的注释状态。只读，绝不写盘。

【什么时候调用】读出状态、不改文件，所以可以随时调用：
1. 你因为任务需要打开了一个文件，看完顺手检查它的注释状态
2. 用户问"这文件什么状态""还差什么""补到哪了"
3. 准备调用 annotate 之前先自检 —— 拿到精确的缺口清单，避免重复补或漏补
4. 用户说"看看注释全不全"

【不要调用】
· 用户只是想让你读内容、不需要注释状态
· 记忆\\ 下的材料文件（材料层不含注释）

【这个工具不写盘】看完要落笔，用 annotate。`,

        parameters: {
            file: {
                type: 'string',
                required: true,
                description: '工作区相对路径或绝对路径'
            },
            workspace: {
                type: 'string',
                description: '工作区目录的绝对路径。缺省用当前会话 cwd'
            }
        },

        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }]
        },

        async execute(args, exec) {
            try {
                const { file } = args ?? {}

                // ── 解析工作区路径（与 annotate.js 同链，但只读不改）──
                let cwd = null
                try {
                    cwd = exec?.agent?.session?.header?.cwd ?? null
                } catch (err) {
                    console.warn('[parse_prompt] 读取 agent.session 失败：', err?.message ?? err)
                }

                if (!cwd) {
                    let sessionId = null
                    try {
                        sessionId = exec?.agent?.id ?? exec?.sessionId ?? null
                    } catch {}
                    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
                    if (sessionId && sessions?.get) {
                        try {
                            const session = await sessions.get(sessionId)
                            cwd = session?.header?.cwd ?? session?.meta?.cwd ?? null
                        } catch (err) {
                            console.warn('[parse_prompt] 读取会话失败：', err?.message ?? err)
                        }
                    }
                }

                const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
                let wsPath = null
                if (cwd && registry?.resolveByPath) {
                    try {
                        const ws = await registry.resolveByPath(cwd)
                        wsPath = ws?.path ?? null
                    } catch (err) {
                        console.warn('[parse_prompt] resolveByPath 失败：', err?.message ?? err)
                    }
                }

                const basePath = args.workspace ?? wsPath ?? cwd ?? fallbackWorkspace ?? process.cwd()
                if (!path.isAbsolute(basePath)) {
                    return `无法解析工作区路径（${basePath}）`
                }

                // ── 定位文件；不存在 → 报错，不创建 ──
                let filePath = file
                if (!path.isAbsolute(filePath)) {
                    filePath = path.join(basePath, filePath)
                }
                try {
                    await fs.access(filePath)
                } catch {
                    return `文件不存在，请先创建：${file}`
                }

                // ── 读取 + 解析 ──
                const raw = await fs.readFile(filePath, 'utf-8')
                const parsed = parsePrompt(raw)

                // ── 生成报告（缺项显式打印"无"，区分"查了没有"与"没查"）──
                const out = []

                // 标题
                if (parsed.titleRaw) {
                    out.push(`标题：${parsed.title}（第 ${parsed.titleLine + 1} 行）`)
                } else {
                    out.push('标题：（文件为空，无标题）')
                }

                // 正文：用切片总行数（与行号区间一致，含空行）
                const bodyCount = parsed.bodyLines.length
                if (bodyCount > 0) {
                    out.push(`正文：${bodyCount} 行（第 ${parsed.bodyStart + 1}–${parsed.bodyEnd} 行）`)
                } else {
                    out.push('正文：（空）')
                }

                // 注释区
                out.push(`注释：${parsed.comments.length} 条`)
                out.push(parsed.pending.length
                    ? `  · 待补（空内容）：${parsed.pending.join(' / ')}`
                    : '  · 待补：无')
                out.push(parsed.noBasis.length
                    ? `  · 缺依据：${parsed.noBasis.join(' / ')}`
                    : '  · 缺依据：无')

                // 出处区
                if (parsed.sourceRange) {
                    const span = lineSpan(parsed.sourceLines, parsed.sourceRange, parsed._lines)
                    // 实际出处条目数（非空且能匹配 ← 的）
                    const count = parsed.comments.filter(c => c.basis).length
                    out.push(`出处：${count} 条（第 ${span.first}–${span.last} 行）`)
                } else {
                    out.push('出处：无')
                }

                // 未识别行
                if (parsed.unparsed.length > 0) {
                    const items = parsed.unparsed
                        .map(u => `第 ${u.line} 行「${preview(u.text)}」`)
                        .join('、')
                    out.push(`未识别行：${parsed.unparsed.length} 行（${items}）`)
                } else {
                    out.push('未识别行：0 行')
                }

                // 警告
                if (parsed.warnings.length > 0) {
                    out.push(`警告：${parsed.warnings.length} 条`)
                    for (const w of parsed.warnings) out.push(`  · ${w}`)
                } else {
                    out.push('警告：无')
                }

                out.push(`文件：${filePath}`)
                // 只读证据：内容 hash（用于证明"调用前后文件未变"）
                const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
                out.push(`sha256：${hash}（只读，未写盘）`)

                return out.join('\n')
            } catch (err) {
                return `解析失败：${err?.message ?? err}`
            }
        }
    })
}
