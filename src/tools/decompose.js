import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { checkNotes, parseSemantic, renderSemantic, semanticPathFor } from '../core/text.js'

const SYSTEM = `你是语义划分器。把正文按语义分组，只输出列表本身。

格式（逐条照做）：
1. 一句一行：正文在 。！？； 处断句，一句原样占一行。
2. 次序不变：行序 = 正文语序。不合句、不拆句、不重复、不遗漏。
3. 组间空一行：同一方面的相邻句归一组，组与组之间只空一行（不是两行）。
4. 一字不动：不改标点、不补字、不删字、不换词。
5. 只输出列表：不写前言、不写解释、不编号、不加标题、不包代码块。`

/** 重试次数上限（含首次） */
const MAX_ATTEMPTS = 3

/** 输出上限（含推理），可按需调 */
const DEFAULT_MAX_TOKENS = 8192

/**
 * 这类「按格式照抄并分组」的任务不需要思考，而推理 token 与正文共享 maxTokens：
 * 会话 reasoningEffort=high 时，模型可能把配额全花在思考上，正文一个字都不剩。
 * 所以显式请求 off；provider 不支持 off 时自动退回默认档。
 */
const OFF_EFFORT = ReasoningEffortId('off')

/** 该 provider 不认这个推理档位时的报错特征 */
const EFFORT_REJECTED = /reasoning effort|推理档/i

/**
 * 把一次截断说清楚：上限多少、正文与推理各产出多少字、正文开头是什么。
 * 「被截断」既可能是正文太长，也可能是推理吃光了配额——两者处置完全不同。
 */
function describeTruncation(blocks, maxTokensUsed) {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('')
    const head = text.slice(0, 300) || '（空）'
    return [
        `输出被 maxTokens 截断（上限 ${maxTokensUsed}）：正文 ${text.length} 字，推理 ${reasoning.length} 字。`,
        reasoning.length > text.length
            ? '推理占了大部分配额——应关闭思考（reasoningEffort=off）或提高 maxTokens。'
            : '正文本身过长——请把源文件分段后再拆。',
        `正文开头：${head}`,
    ].join('\n')
}

/** 跑一次流，把「调用失败」与「正常结束」分开。 */
async function streamOnce(ctx, exec, prompt, reasoningEffort) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (!llm?.stream) return { ok: false, kind: 'no-llm', error: '宿主没有 llm 服务' }

    const route = exec?.agent?.options ?? {}
    if (!route.provider || !route.model) {
        return { ok: false, kind: 'no-route', error: '拿不到当前会话的 provider/model' }
    }

    const maxTokensUsed = route.maxTokens ?? DEFAULT_MAX_TOKENS
    const messages = [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dieci-compiler' },
    })]

    const assembler = new BlockAssembler()
    try {
        for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model,
            messages,
            system: SYSTEM,
            temperature: 0,
            maxTokens: maxTokensUsed,
            ...reasoningEffort === undefined ? {} : { reasoningEffort },
            signal: exec?.signal,
        })) {
            assembler.push(chunk)
        }
    } catch (err) {
        return { ok: false, kind: 'threw', error: `模型调用出错：${err?.message ?? err}` }
    }

    if (assembler.finish?.kind === 'error') {
        return { ok: false, kind: 'threw', error: `模型调用出错：${assembler.finish.failure?.message ?? '未知错误'}` }
    }
    if (assembler.finish?.kind === 'max-tokens') {
        return { ok: false, kind: 'truncated', error: describeTruncation(assembler.blocks(), maxTokensUsed) }
    }

    const text = assembler.blocks()
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
    return { ok: true, text }
}

/** 调模型：先请求 off（不思考），provider 不认这个档位就退回会话默认档。 */
async function callModel(ctx, exec, prompt) {
    const first = await streamOnce(ctx, exec, prompt, OFF_EFFORT)
    if (first.ok) return first
    if (first.kind !== 'threw' || !EFFORT_REJECTED.test(first.error)) return first

    const second = await streamOnce(ctx, exec, prompt, undefined)
    if (second.ok) return second
    return {
        ok: false,
        error: `${second.error}\n（注：provider 不接受 reasoningEffort=off，已退回默认档；若仍被截断，说明思考占了预算。）`,
    }
}

// ─── 把自检结果写成人话，交回模型重做 ───
function feedbackFor(report) {
    const parts = []
    const line = items => items.slice(0, 6).map(l => `· ${l}`).join('\n')
    if (report.bad.length) parts.push(`这些行与正文对不上（改字/编造/次序不对）：\n${line(report.bad)}`)
    if (report.missing.length) parts.push(`这些源句没有出现：\n${line(report.missing)}`)
    if (report.problems.length) parts.push(`结构问题：\n${line(report.problems)}`)
    return parts.join('\n')
}

// ─── 工具工厂 ───
export function makeDecomposeTool({ ctx } = {}) {
    return defineTool({
        name: 'decompose',
        description: `划分语义：读文件正文，调模型做语义划分并自检，通过后落盘到 语义/<主名>-语义.txt。
【参数】
- file：被划分的源文件，绝对路径，必填。
【行为】
- 读文件正文。
- 调模型划分（当前会话的 provider/model，temperature 0，不思考）。
- 自检：一句一行、行序同源文、一字不改、组间恰好一个空行、每句都在且不重复。
- 不通过就不落盘，带问题清单重试（最多 3 次）；仍不通过则保留旧语义文件并报错。
- 通过后写 源文件同目录/语义/<主名>-语义.txt；源文件不动。`,
        parameters: {
            file: {
                type: 'string',
                required: true,
                description: '被划分的源文件，绝对路径',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },

        async execute(args, exec) {
            try {
                const file = String(args?.file ?? '').trim()
                if (!file) return '拆解失败：缺少 file 参数（被划分的源文件绝对路径）'
                if (!path.isAbsolute(file)) return `拆解失败：file 必须是绝对路径（${file}）`

                // ── 1. 读正文 ──
                const raw = await fs.readFile(file, 'utf-8').catch(() => null)
                if (raw === null) return `拆解失败：文件读不了（${file}）`
                const body = raw.replace(/^\uFEFF/u, '').trim()
                if (!body) return `拆解失败：文件没有正文（${file}）`

                // ── 2. 调模型 + 自检 + 重试 ──
                let report = null
                let noteText = ''
                let attempts = 0

                for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    attempts = attempt
                    const prompt = attempt === 1
                        ? body
                        : `${body}\n\n—— 上一轮输出不合格，问题如下 ——\n${feedbackFor(report)}\n请按格式重做，只输出列表。`

                    const r = await callModel(ctx, exec, prompt)
                    if (!r.ok) return `拆解失败：${r.error}`

                    const lines = parseSemantic(r.text)
                    if (!lines.some(Boolean)) {
                        report = { bad: [], missing: [], problems: ['模型没有输出语义单元'] }
                        continue
                    }

                    noteText = renderSemantic(lines)
                    report = checkNotes(body, noteText)
                    if (report.ok) break
                }

                // ── 3. 检查不过：不落盘，保留旧文件 ──
                if (!report?.ok) {
                    const detail = [
                        report?.bad.length ? `保真未过：\n` + report.bad.map(l => `  · ${l}`).join('\n') : '',
                        report?.missing.length ? `覆盖未过：\n` + report.missing.map(l => `  · ${l}`).join('\n') : '',
                        report?.problems.length ? `结构未过：\n` + report.problems.map(l => `  · ${l}`).join('\n') : '',
                    ].filter(Boolean).join('\n')
                    return [
                        `拆解失败：${attempts} 次尝试均未通过自检，未落盘（旧语义文件未改动）`,
                        `源文件：${file}`,
                        detail || '原因未知',
                    ].join('\n')
                }

                // ── 4. 落盘 ──
                const outPath = semanticPathFor(file, path)
                await fs.mkdir(path.dirname(outPath), { recursive: true })
                await fs.writeFile(outPath, noteText.replace(/^\uFEFF/u, ''), 'utf-8')

                // ── 5. 回报 ──
                const out = [
                    `已划分 ${report.groupCount} 组，共 ${report.noteCount} 句`,
                    `源文件：${file}`,
                    `输出：${outPath}`,
                    `保真：通过（${report.noteCount} 行逐行对上原文）`,
                    `覆盖：通过（源文 ${report.sentenceCount} 句）`,
                    `结构：通过（一句一行、组间一个空行）`,
                ]
                if (attempts > 1) out.push(`注：第 ${attempts} 次尝试才通过自检`)
                return out.join('\n')
            } catch (err) {
                return `拆解失败：${err?.message ?? err}`
            }
        },
    })
}
