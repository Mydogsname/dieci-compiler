import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * compose —— 注释 + 残句 → 成品。
 *
 * 原料只有两块，此外没有别的材料：
 *   · 注释文件：逐行「词：原句」，同词多句两空格缩进续行（dieci 产出）
 *   · 残句文件：没被任何词引用的句子，括号里是来源文件（dieci 产出）
 * 不读源文件、不读语义文件、不重新配对、不引入常识。
 *
 * 成品首行是「主题：…」——主题只能由注释里出现过的词组成，用来约束成稿不跑题。
 */

const OFF_EFFORT = ReasoningEffortId('off')

/** 输出上限（含推理） */
const DEFAULT_MAX_TOKENS = 8192

/** 该 provider 不认这个推理档位时的报错特征 */
const EFFORT_REJECTED = /reasoning effort|推理档/i

/** 成品首行的主题行 */
const THEME_LINE = /^主题[:：]\s*(.+)$/u

/** 注释里的条目行：顶格的「词：」；缩进行是续行 */
const ENTRY_LINE = /^([^：:\s][^：:]{0,19})[:：]\s*\S/u

const SYSTEM = `你是成稿器。用户给你两块原料，此外没有别的材料。

【注释】一个词一条，词后面是与之相关的原句；两空格缩进的续行属于同一条。
【残句】不属于任何词的零散句子，括号里是来源文件。

任务分两步：
1. 定主题：输出一行「主题：」加一句话。主题必须由注释里出现过的词组合而成，
   不许引入注释中没有的实体、风格或情绪。
2. 空一行，再写成稿正文：一段或几段连贯、可直接使用的中文文字。

成稿规则：
- 只能使用这两块原料里出现过的事实与用词；不得新增人物、物件、风格词、细节或常识。
- 原料里的否定约束（如「不要人物」「不要现代元素」）必须原样保留其含义，不得丢弃或弱化。
- 注释内部若互相矛盾，选与主题最契合的一支，成稿只表达这一支，不要含混并置。
- 可以调整语序、合并、补连接词与标点，让文字连贯。
- 不写标题、不解释、不提到「注释」「残句」「素材」这类元信息。

输出只有两段：主题行 + 正文。`

/**
 * 把一次截断说清楚：上限多少、正文与推理各产出多少字。
 */
function describeTruncation(blocks, maxTokensUsed) {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('')
    return [
        `输出被 maxTokens 截断（上限 ${maxTokensUsed}）：正文 ${text.length} 字，推理 ${reasoning.length} 字。`,
        reasoning.length > text.length
            ? '推理占了大部分配额——应关闭思考（reasoningEffort=off）或提高 maxTokens。'
            : '正文本身过长——减少原料或收紧成稿长度。',
        `正文开头：${text.slice(0, 300) || '（空）'}`,
    ].join('\n')
}

/** 跑一次流，把「调用失败」与「正常结束」分开。 */
async function streamOnce(ctx, exec, system, prompt, reasoningEffort) {
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
            system,
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

    return {
        ok: true,
        text: assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('').trim(),
    }
}

/** 调模型：先请求 off（不思考），provider 不认这个档位就退回会话默认档。 */
async function callModel(ctx, exec, system, prompt) {
    const first = await streamOnce(ctx, exec, system, prompt, OFF_EFFORT)
    if (first.ok) return first
    if (first.kind !== 'threw' || !EFFORT_REJECTED.test(first.error)) return first

    const second = await streamOnce(ctx, exec, system, prompt, undefined)
    if (second.ok) return second
    return {
        ok: false,
        error: `${second.error}\n（注：provider 不接受 reasoningEffort=off，已退回默认档；若仍被截断，说明思考占了预算。）`,
    }
}

/** 注释里的词（顶格条目的词），用来校验主题没跑出注释之外。 */
function noteTerms(noteText) {
    const terms = []
    for (const line of String(noteText ?? '').split('\n')) {
        if (!line.trim() || /^\s/u.test(line)) continue
        const m = ENTRY_LINE.exec(line)
        if (m) terms.push(m[1].trim())
    }
    return terms
}

/**
 * 拆出主题行与正文。
 * @returns {{ theme: string, body: string }} 没有主题行时 theme 为空、body 为全文
 */
function splitTheme(text) {
    const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n')
    const firstIndex = lines.findIndex(l => l.trim())
    if (firstIndex === -1) return { theme: '', body: '' }

    const m = THEME_LINE.exec(lines[firstIndex].trim())
    if (!m) return { theme: '', body: lines.join('\n').trim() }

    const body = lines.slice(firstIndex + 1).join('\n').trim()
    return { theme: m[1].trim(), body }
}

// ─── 工具工厂 ───
export function makeComposeTool({ ctx } = {}) {
    return defineTool({
        name: 'compose',
        description: `成品（compose）：读注释文件与残句文件，产出「主题 + 成稿」的成品文件。
【参数】
- note：注释文件绝对路径，必填（dieci 产出的 叠词-注释.txt）。
- residual：残句文件绝对路径，可选；缺省由 note 推导为同目录 叠词-残句.txt。文件不存在按「无残句」处理。
- out：成品落盘路径，可选；不传只在返回里给文本。
【原料边界】
- 只有注释与残句两块，不读源文件、不读语义文件、不重新配对。
- 成品首行「主题：…」，主题只能由注释里出现过的词组成。
【纪律】
- 注释里没有注释条目时直接报错，不猜。
- 主题若含注释外的成分，面板告警但不改动成品。`,
        parameters: {
            note: {
                type: 'string',
                required: true,
                description: '注释文件绝对路径（dieci 产出的 叠词-注释.txt）',
            },
            residual: {
                type: 'string',
                description: '残句文件绝对路径（可选，缺省取同目录 叠词-残句.txt）',
            },
            out: {
                type: 'string',
                description: '成品落盘路径（可选）',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },

        async execute(args, exec) {
            try {
                const note = String(args?.note ?? '').trim()
                if (!note) return '成稿失败：缺少 note 参数（注释文件绝对路径）'
                if (!path.isAbsolute(note)) return `成稿失败：note 必须是绝对路径（${note}）`

                const outArg = String(args?.out ?? '').trim()
                if (outArg && !path.isAbsolute(outArg)) {
                    return `成稿失败：out 必须是绝对路径（${outArg}）`
                }

                // ── 1. 读注释 ──
                const noteText = await fs.readFile(note, 'utf-8').catch(() => null)
                if (noteText === null) return `成稿失败：注释文件读不了（${note}）`

                const terms = noteTerms(noteText)
                if (!terms.length) {
                    return `成稿失败：注释文件里没有注释条目（${note}）。请先调用 dieci 生成注释。`
                }

                // ── 2. 读残句（缺省推导；不存在按空处理）──
                let residualPath = String(args?.residual ?? '').trim()
                if (residualPath && !path.isAbsolute(residualPath)) {
                    return `成稿失败：residual 必须是绝对路径（${residualPath}）`
                }
                if (!residualPath) {
                    const base = path.basename(note)
                    const guess = base.replace(/-注释\.txt$/u, '-残句.txt')
                    residualPath = path.join(path.dirname(note), guess)
                }

                const residualRaw = await fs.readFile(residualPath, 'utf-8').catch(() => null)
                const residualText = residualRaw === null ? '' : residualRaw.trim()

                // ── 3. 拼原料：只有这两块 ──
                const prompt = [
                    '【注释】',
                    noteText.trim(),
                    residualText ? '\n【残句】\n' + residualText : '',
                ].filter(Boolean).join('\n')

                const r = await callModel(ctx, exec, SYSTEM, prompt)
                if (!r.ok) return `成稿失败：${r.error}`

                // ── 4. 拆主题与正文 ──
                const { theme, body } = splitTheme(r.text)
                if (!body) return `成稿失败：模型只给了主题，没有正文\n主题：${theme || '（缺）'}`

                const productText = theme ? `主题：${theme}\n\n${body}\n` : body + '\n'

                // ── 5. 落盘 ──
                if (outArg) {
                    await fs.mkdir(path.dirname(outArg), { recursive: true })
                    await fs.writeFile(outArg, productText, 'utf-8')
                }

                // ── 6. 回报 ──
                const notes = []
                if (!theme) notes.push('模型未给出主题行，成品只有正文')
                else {
                    const stray = terms.length && !terms.some(t => theme.includes(t))
                    if (stray) notes.push(`主题未包含任何注释里的词，请核对：${theme}`)
                }
                if (!residualText) notes.push('无残句，原料只有注释')

                return [
                    productText.trimEnd(),
                    '',
                    `已落盘：${outArg || '（未指定 out，仅返回文本）'}`,
                    ...notes.map(n => `注：${n}`),
                ].join('\n')
            } catch (err) {
                return `成稿失败：${err?.message ?? err}`
            }
        },
    })
}