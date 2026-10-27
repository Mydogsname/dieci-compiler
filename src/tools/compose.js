import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { workspaceName } from '../core/text.js'

/**
 * compose —— 注释表（一份或多份）+ 剩余文本 → 成品。
 *
 * 原料只有两块，此外没有别的材料：
 *   · 注释表：逐行「词：原句」，同词多句两空格缩进续行（dieci 与 supplement 产出，同构）
 *   · 剩余文本：没被任何词收走的句子，括号里是来源文件
 * 不读源文件、不读语义文件、不重新配对、不引入常识。
 *
 * 多份注释表的顺序即叠层顺序：
 *   先 <工作区名>-注释.txt（dieci 的无题划分，管内容），
 *   再其余 <题目>-注释.txt（supplement 的有题划分，补规格与约束）。
 * 不给路径时自动扫 <工作区>\叠词\，按这个顺序拼。
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

/** 注释表目录名：<工作区>\叠词\ */
const OUT_DIR = '叠词'

/** 注释表后缀：<题目>-注释.txt，题目即主题 */
const PLAIN_SUFFIX = '-注释.txt'

const SYSTEM = `你是成稿器。用户给你两块原料，此外没有别的材料。

【注释】一个词一条，词后面是与之相关的原句；两空格缩进的续行属于同一条。
【剩余文本】不属于任何词的零散句子，括号里是来源文件。

任务：
1. 定主题：一句话，必须由注释里出现过的词组合而成，不许引入注释中没有的实体、风格或情绪。
2. 写成稿正文：一段或几段连贯、可直接使用的中文文字。

成稿规则：
- 只能使用这两块原料里出现过的事实与用词；不得新增人物、物件、风格词、细节或常识。
- 原料里的否定约束（如「不要人物」「不要现代元素」）必须原样保留其含义，不得丢弃或弱化。
- 注释内部若互相矛盾，选与主题最契合的一支，成稿只表达这一支，不要含混并置。
- 可以调整语序、合并、补连接词与标点，让文字连贯。
- 正文里不写标题、不解释、不提到「注释」「剩余文本」「素材」这类元信息。

**舍弃要说清**：你按主题砍掉了哪一支，就逐条报出来——砍的是什么（原料里的哪个词、哪些句子所属的那一类），为什么砍（与主题或与哪条约束冲突）。没砍就报空数组。这些只进面板给用户看，不进正文。

直接输出 JSON：
{ "theme": "主题", "body": "成稿正文", "dropped": [ { "what": "被舍弃的部分", "why": "为什么舍弃" } ] }`

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
 * 拆出主题行与正文（旧格式兜底：模型没按 JSON 输出时用）。
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

/**
 * 解析模型输出：{ theme, body, dropped }。
 * 拿不到 JSON 就退回「主题行 + 正文」的老格式，dropped 记为空、并由 json=false 告知调用方。
 * @returns {{ theme: string, body: string, dropped: Array<{what: string, why: string}>, json: boolean }}
 */
function parseProduct(raw) {
    const check = (v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('顶层不是对象')
        if (typeof v.theme !== 'string') throw new Error('theme 不是字符串')
        if (typeof v.body !== 'string' || !v.body.trim()) throw new Error('body 缺失或为空')
        const dropped = Array.isArray(v.dropped) ? v.dropped : []
        for (const [i, d] of dropped.entries()) {
            if (!d || typeof d !== 'object') throw new Error(`dropped[${i}] 不是对象`)
        }
        return {
            theme: v.theme.trim(),
            body: v.body.trim(),
            dropped: dropped
                .map(d => ({
                    what: String(d.what ?? '').trim(),
                    why: String(d.why ?? '').trim(),
                }))
                .filter(d => d.what),
            json: true,
        }
    }

    const text = String(raw ?? '').trim()
    try {
        return check(JSON.parse(text))
    } catch {
        // 容忍 ```json 围栏或前后废话
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start !== -1 && end > start) {
            try {
                return check(JSON.parse(text.slice(start, end + 1)))
            } catch {
                // 落到旧格式兜底
            }
        }
    }

    const { theme, body } = splitTheme(text)
    return { theme, body, dropped: [], json: false }
}

/**
 * 成品文本里的主题——模型没写主题行时返回空串，由调用方决定兜底名字。
 * @param {string} productText 成品全文（首行「主题：…」加一段空行加正文）
 * @returns {string}
 */
export function themeOf(productText) {
    return splitTheme(productText).theme
}

/** 工作区：会话 cwd → process.cwd() */
function workspaceRoot(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
    return process.cwd()
}

/**
 * 扫 <工作区>\叠词\ 下的注释表，按叠层顺序返回：
 *   先 <工作区名>-注释.txt（dieci 的无题划分：管内容），
 *   再其余 <题目>-注释.txt（supplement 的有题划分：补规格与约束），按文件名排序。
 * 同后缀、靠文件名里的题目区分来源；dieci 那份用工作区名，所以置顶。
 * @returns {Promise<string[]>} 绝对路径
 */
async function scanNotes(root) {
    const dir = path.join(root, OUT_DIR)
    const names = (await fs.readdir(dir).catch(() => []))
        .filter(n => n.endsWith(PLAIN_SUFFIX))

    const primary = `${workspaceName(root)}${PLAIN_SUFFIX}`
    const head = names.filter(n => n === primary)
    const rest = names.filter(n => n !== primary).sort()
    return [...head, ...rest].map(n => path.join(dir, n))
}

// ─── 工具工厂 ───
export function makeComposeTool({ ctx } = {}) {
    return defineTool({
        name: 'compose',
        description: `成品（compose）：读一份或多份注释表 + 剩余文本，产出「主题 + 成稿」的成品文件。
【参数】
- notes：注释表绝对路径数组，可选，按顺序叠。缺省扫 <工作区>\\叠词\\ 下全部：
    先 <工作区名>-注释.txt（dieci 的无题划分，管内容），
    再其余 <题目>-注释.txt（supplement 的有题划分，补规格与约束）。
- note：单份注释表绝对路径，可选，等价于只给一份 notes。
- residual：剩余文本绝对路径，可选；缺省 <工作区>\\\\<工作区名>-剩余.txt。不存在按「无剩余文本」处理。
- out：成品落盘路径，可选；不传只在返回里给文本。
【原料边界】
- 只有注释表与剩余文本两块，不读源文件、不读语义文件、不重新配对。
- 成品首行「主题：…」，主题只能由注释表里出现过的词组成。
【纪律】
- 注释表里没有注释条目时直接报错，不猜。
- 主题若含注释表外的成分，面板告警但不改动成品。`,
        parameters: {
            notes: {
                type: 'array',
                items: { type: 'string' },
                description: '注释表绝对路径数组（可选，按顺序叠；缺省扫 叠词\\ 下全部 *-注释.txt，<工作区名>-注释.txt 排最前）',
            },
            note: {
                type: 'string',
                description: '单份注释表绝对路径（可选，等价于只给一份 notes）',
            },
            residual: {
                type: 'string',
                description: '剩余文本绝对路径（可选，缺省取 <工作区>\\\\<工作区名>-剩余.txt）',
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
                const outArg = String(args?.out ?? '').trim()
                if (outArg && !path.isAbsolute(outArg)) {
                    return `成稿失败：out 必须是绝对路径（${outArg}）`
                }

                const root = workspaceRoot(exec)

                // ── 1. 定注释表：显式传入的优先，否则扫 叠词\ ──
                const given = []
                const arr = args?.notes
                if (Array.isArray(arr)) {
                    for (const p of arr) {
                        const v = String(p ?? '').trim()
                        if (!v) continue
                        if (!path.isAbsolute(v)) return `成稿失败：notes 里必须全是绝对路径（${v}）`
                        given.push(v)
                    }
                }
                const single = String(args?.note ?? '').trim()
                if (single) {
                    if (!path.isAbsolute(single)) return `成稿失败：note 必须是绝对路径（${single}）`
                    given.push(single)
                }

                let notePaths = given
                if (!notePaths.length) {
                    notePaths = await scanNotes(root)
                    if (!notePaths.length) {
                        return `成稿失败：${path.join(root, OUT_DIR)} 下没有任何注释表（*-注释.txt）。请先跑 /dieci 或 /supplement。`
                    }
                }
                notePaths = [...new Set(notePaths)]

                // ── 2. 读注释表，按叠层顺序拼接 ──
                const parts = []
                for (const p of notePaths) {
                    const raw = await fs.readFile(p, 'utf-8').catch(() => null)
                    if (raw === null) return `成稿失败：注释表读不了（${p}）`
                    if (!raw.trim()) return `成稿失败：注释表是空的（${p}）`
                    parts.push({ path: p, text: raw.trim() })
                }

                const allTerms = [...new Set(parts.flatMap(p => noteTerms(p.text)))]
                if (!allTerms.length) {
                    return `成稿失败：注释表里没有注释条目（${notePaths.join('、')}）。请先跑 /dieci 或 /supplement。`
                }

                // ── 3. 读剩余文本（缺省 <工作区>\<工作区名>-剩余.txt；不存在按空处理）──
                let residualPath = String(args?.residual ?? '').trim()
                if (residualPath && !path.isAbsolute(residualPath)) {
                    return `成稿失败：residual 必须是绝对路径（${residualPath}）`
                }
                if (!residualPath) residualPath = path.join(root, `${workspaceName(root)}-剩余.txt`)

                const residualRaw = await fs.readFile(residualPath, 'utf-8').catch(() => null)
                const residualText = residualRaw === null ? '' : residualRaw.trim()

                // ── 4. 拼原料：注释表（可多层）+ 剩余文本 ──
                const prompt = [
                    parts.length === 1 ? '【注释】' : '【注释·按层】',
                    parts.map((p, i) => (parts.length === 1 ? p.text : `第 ${i + 1} 层（${path.basename(p.path)}）\n${p.text}`)).join('\n\n'),
                    residualText ? '\n【剩余文本】\n' + residualText : '',
                ].filter(Boolean).join('\n')

                const r = await callModel(ctx, exec, SYSTEM, prompt)
                if (!r.ok) return `成稿失败：${r.error}`

                // ── 5. 解析成品：主题 + 正文 + 舍弃清单 ──
                const { theme, body, dropped, json } = parseProduct(r.text)
                if (!body) return `成稿失败：模型没有给出正文\n原始输出：${r.text.slice(0, 400)}`

                const productText = theme ? `主题：${theme}\n\n${body}\n` : body + '\n'

                // ── 6. 落盘 ──
                if (outArg) {
                    await fs.mkdir(path.dirname(outArg), { recursive: true })
                    await fs.writeFile(outArg, productText, 'utf-8')
                }

                // ── 7. 回报 ──
                const notes = []
                if (!json) notes.push('模型没按 JSON 输出，舍弃清单缺失（其余照常）')
                if (!theme) notes.push('模型未给出主题，成品只有正文')
                else {
                    const stray = allTerms.length && !allTerms.some(t => theme.includes(t))
                    if (stray) notes.push(`主题未包含任何注释里的词，请核对：${theme}`)
                }
                if (!residualText) notes.push(`无剩余文本，原料只有注释表（${residualPath} 不存在）`)

                const droppedLines = dropped.length
                    ? [
                        '',
                        `舍弃 ${dropped.length} 支（这些没进正文）：`,
                        ...dropped.map((d, i) => `  ${i + 1}. ${d.what}${d.why ? ` —— ${d.why}` : ''}`),
                        '',
                        '原料若不该被舍弃，改注释表或剩余文本后重跑。',
                    ]
                    : ['', '舍弃：无（原料全部用上）']

                return [
                    productText.trimEnd(),
                    '',
                    `已落盘：${outArg || '（未指定 out，仅返回文本）'}`,
                    `原料：${parts.length} 层注释（${parts.map(p => path.basename(p.path)).join(' / ')}）${residualText ? ' + 剩余文本' : ''}`,
                    ...droppedLines,
                    ...notes.map(n => `注：${n}`),
                ].join('\n')
            } catch (err) {
                return `成稿失败：${err?.message ?? err}`
            }
        },
    })
}