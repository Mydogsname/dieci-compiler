import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { RECORD_NAME, recordLine, appendRecord } from '../core/record.js'

/**
 * supplement（补充）—— 有题提取：从剩余文本里按题目另立一张主题注释表。
 *
 * 与 dieci 的分工：
 *   dieci      无题提取（同指）：多份语义 → 注释表 + 剩余文本
 *   supplement 有题提取（同题）：剩余文本 + 题目 → 主题注释表
 *   两者都只做注释；成品由 compose 出。
 *
 * 剩余文本 = 语义集合里还没被任何题目收走的部分。它只减不增：
 * 每次补充取走一批就删掉，取空是正常的终点。
 *
 * 纪律（代码强制）：
 *   · 模型只报句序号，原句由本工具回填，杜绝改字；
 *   · 同一句只归一个词；越界、重复、单句成词一律丢弃并计数；
 *   · 与题目无关的句子不引用——它们留在剩余文本里等下一个题目；
 *   · 落盘顺序 = 注释表 → 剩余文本 → 提取记录，任一步失败即停并报明现状。
 */
const OFF_EFFORT = ReasoningEffortId('off')

/** 输出上限（含推理） */
const DEFAULT_MAX_TOKENS = 8192

/** 该 provider 不认这个推理档位时的报错特征 */
const EFFORT_REJECTED = /reasoning effort|推理档/i

/** 注释表落点：<工作区>\叠词\<题目>-注释.txt（题目就是主题，与 dieci 的 <工作区名>-注释.txt 同构） */
const OUT_DIR = '叠词'

/** 注释表后缀：题目在前，-注释 在后 */
const NOTE_SUFFIX = '-注释.txt'

/** 剩余文本的文件名后缀 */
const REMAIN_SUFFIX = '-剩余.txt'

/** 剩余文本行首的（来源文件），只用于保留原样，注释表里不带 */
const SOURCE_PREFIX = /^（[^）]*）/u

/** 文件名里不能出现的字符 */
const ILLEGAL_IN_NAME = /[\\/:*?"<>|\u0000-\u001f]/gu

/** 题目过长时截断，给 -注释.txt 后缀留位置 */
const TITLE_MAX = 60

const SYSTEM = `用户给你一个题目和一批句子（一句一行，带序号）。

题目划出一个**语义范围**。你只做一件事：逐句判断，这句在语义上属不属于这个范围。

- 依据是句子在讲什么，不是句子里出现了哪些字。
  例：题目「约束」时，「不要人物」属于；「人物站姿微侧」不属于，哪怕它也含「人物」。
- 属于的一律收进来，哪怕句式不同、哪怕只有两句；不属于的一律不报，哪怕它和别的句子很像。
- 判断不确定就按不属于处理：漏收由用户补，错收没法退。
- 只报句序号，不抄原句、不解释、不写别的字段。

直接输出 JSON：{ "matches": [属于这个范围的句序号…] }`

/** 把一次截断说清楚：上限多少、正文与推理各产出多少字。 */
function describeTruncation(blocks, maxTokensUsed) {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('')
    return [
        `输出被 maxTokens 截断（上限 ${maxTokensUsed}）：正文 ${text.length} 字，推理 ${reasoning.length} 字。`,
        reasoning.length > text.length
            ? '推理占了大部分配额——应关闭思考（reasoningEffort=off）或提高 maxTokens。'
            : '正文本身过长——减少剩余文本或收紧每词的句数。',
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

// ─── 解析 ───

/** 去掉（来源文件）前缀，得到裸句 */
function bare(line) {
    return String(line ?? '').replace(SOURCE_PREFIX, '').trim()
}

/**
 * 读剩余文本：lines 保留原始行（写回时原样输出），bare 是给模型看的裸句。
 * @returns {Promise<{ lines: string[], bare: string[] } | null>}
 */
async function readRemaining(file) {
    const raw = await fs.readFile(file, 'utf-8').catch(() => null)
    if (raw === null) return null
    const lines = raw
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
    return { lines, bare: lines.map(bare) }
}

/**
 * 解析模型输出：只要 matches（属于这个题目的句序号）。
 * 词名不由模型决定——题目就是词名，由工具填。
 */
function parseClaim(raw) {
    const check = (v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('顶层不是对象')
        if (!Array.isArray(v.matches)) throw new Error('matches 不是数组')
        for (const [i, s] of v.matches.entries()) {
            if (!Number.isInteger(s)) throw new Error(`matches[${i}] 必须是句序号（整数）`)
        }
        return { matches: v.matches }
    }

    try {
        return check(JSON.parse(raw))
    } catch (err) {
        const start = raw.indexOf('{')
        const end = raw.lastIndexOf('}')
        if (start === -1 || end <= start) throw new Error(`模型未返回 JSON\n原始输出：${raw.slice(0, 500)}`)
        try {
            return check(JSON.parse(raw.slice(start, end + 1)))
        } catch {
            throw new Error(`模型返回的 JSON 不合格：${err?.message ?? err}\n原始输出：${raw.slice(0, 500)}`)
        }
    }
}

/**
 * 句序号回填：模型只报序号，原句由本工具取回。
 * 词只有一个——就是这个题目；不够 2 句不成组（单条依据只是标签）。
 * @returns {{ entry: { term: string, matches: any[] } | null, claimed: Set<number>, outOfRange: number, duplicated: number, thin: number }}
 */
function resolveClaims(bareLines, matches, term) {
    const claimed = new Set()
    const kept = []
    let outOfRange = 0
    let duplicated = 0

    for (const s of matches) {
        if (!Number.isInteger(s) || s < 1 || s > bareLines.length) {
            outOfRange++
            continue
        }
        if (claimed.has(s)) {
            duplicated++
            continue
        }
        claimed.add(s)
        kept.push({ index: s, sentence: bareLines[s - 1] })
    }

    if (kept.length < 2) {
        return { entry: null, claimed: new Set(), outOfRange, duplicated, thin: kept.length }
    }

    kept.sort((a, b) => a.index - b.index)
    return { entry: { term, matches: kept }, claimed, outOfRange, duplicated, thin: 0 }
}

// ─── 渲染 ───

/** 注释表正文：一个词一条，首句跟「词：」后，其余两空格缩进续行。 */
function renderAnnotation(entries) {
    const lines = []
    for (const e of entries) {
        e.matches.forEach((m, i) => {
            lines.push(i === 0 ? `${e.term}：${m.sentence}` : `  ${m.sentence}`)
        })
    }
    return lines.length ? lines.join('\n') + '\n' : ''
}

/** 剩余文本写回：被取走的行删掉，其余原样保留（含（来源）前缀）。 */
function renderRemaining(lines, claimed) {
    const rest = lines.filter((_, i) => !claimed.has(i + 1))
    return rest.length ? rest.join('\n') + '\n' : ''
}

/** 题目 → 合法文件名：去非法字符、压空白、收尾去点；清空则返回空串交给兜底。 */
function titleFromTopic(topic) {
    const cleaned = String(topic ?? '')
        .replace(/[\r\n\t]+/gu, ' ')
        .replace(ILLEGAL_IN_NAME, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/^[. ]+|[. ]+$/gu, '')
    if (!cleaned) return ''
    return (cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX) : cleaned).trim()
}

/** 面板：题目、收录句数、剩余、丢弃计数、落盘路径。 */
function renderPanel({ title, entry, taken, left, paths, dropped }) {
    const lines = [
        `题目：${title}`,
        entry ? `注释表：1 个词（${entry.term}）、${taken} 句。` : '注释表：未成立（不足 2 句）',
        `剩余文本：取走 ${taken} 句，剩 ${left} 句。`,
    ]

    const notes = []
    if (dropped.duplicated) notes.push(`丢弃 ${dropped.duplicated} 条重复引用（同一句报了两次）`)
    if (dropped.outOfRange) notes.push(`丢弃 ${dropped.outOfRange} 条越界引用`)
    if (dropped.thin) notes.push(`题目只命中 ${dropped.thin} 句，不足 2 句，未成组`)
    if (notes.length) lines.push('', ...notes.map(n => `注：${n}`))

    if (entry) {
        lines.push('', `注释表已落盘：${paths.note}`)
        lines.push(`剩余文本已写回：${paths.remain}`)
        if (paths.record) lines.push(`提取记录已追加：${paths.record}`)
    } else {
        lines.push('', '剩余文本未改动，注释表未写。')
    }
    return lines.join('\n')
}

/** 工作区：会话 cwd → process.cwd() */
function workspaceRoot(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
    return process.cwd()
}

/** 根目录下的 *-剩余.txt；没有或多于一份都要求显式传 residual。 */
async function findRemaining(root) {
    return (await fs.readdir(root).catch(() => []))
        .filter(n => n.endsWith(REMAIN_SUFFIX))
        .sort()
}

// ─── 工具工厂 ───
export function makeSupplementTool({ ctx } = {}) {
    return defineTool({
        name: 'supplement',
        description: `补充（supplement）：有题提取——把题目当作一个语义范围，从剩余文本里挑出属于这个范围的句子，收成一个词。
【参数】
- input：必填，题目。它同时是判断依据（哪句属于这个语义范围）和词名（注释表里那条「词：」）。input 本身不进注释表、不进正文。
- residual：可选。剩余文本路径；缺省取工作区根目录下唯一的 *-剩余.txt。
- out：可选。注释表落点，缺省 叠词\\<题目>-注释.txt。
- outRecord：可选。提取记录落点，缺省 根目录\\提取记录.txt。
【产物】
- 注释表：只有一条「<题目>：第 1 句」，其余句两空格缩进。没有凑够 2 句就不成组、不落盘。
- 剩余文本：被取走的句子删掉，未引用的原样保留（只减不增）。
- 提取记录：追加一行「时间 工具 题目 取走 N 句 剩余 M 句」。
【纪律】
- 模型只报句序号，原句由工具回填，杜绝改字。
- 判断依据是句子在讲什么，不是句子里出现了哪些字。
- 越界、重复引用一律丢弃并计数；与题目无关的句子留在剩余文本里等下一个题目。`,
        parameters: {
            input: {
                type: 'string',
                required: true,
                description: '题目来源；工具据此从剩余文本里提取，input 本身不进注释表',
            },
            residual: {
                type: 'string',
                description: '剩余文本路径（可选，缺省取工作区根目录下唯一的 *-剩余.txt）',
            },
            out: {
                type: 'string',
                description: '注释表落点（可选，缺省 叠词\\<题目>-注释.txt）',
            },
            outRecord: {
                type: 'string',
                description: '提取记录落点（可选，缺省 根目录\\提取记录.txt）',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },

        async execute(args, exec) {
            try {
                const input = String(args?.input ?? '').trim()
                if (!input) return '补充失败：缺少 input（题目来源）'

                for (const [key, val] of [
                    ['residual', args?.residual],
                    ['out', args?.out],
                    ['outRecord', args?.outRecord],
                ]) {
                    const v = String(val ?? '').trim()
                    if (v && !path.isAbsolute(v)) return `补充失败：${key} 必须是绝对路径（${v}）`
                }

                const root = workspaceRoot(exec)

                // ── 1. 定位剩余文本 ──
                let remainPath = String(args?.residual ?? '').trim()
                if (!remainPath) {
                    const found = await findRemaining(root)
                    if (!found.length) {
                        return `补充失败：根目录下没有 *${REMAIN_SUFFIX}（${root}）。请先调用 dieci 生成剩余文本。`
                    }
                    if (found.length > 1) {
                        return [
                            `补充失败：根目录下有 ${found.length} 份剩余文本，不知道用哪份：`,
                            ...found.map(n => `  · ${n}`),
                            '请用 residual 参数显式指定。',
                        ].join('\n')
                    }
                    remainPath = path.join(root, found[0])
                }

                const remain = await readRemaining(remainPath)
                if (remain === null) return `补充失败：剩余文本读不了（${remainPath}）`
                if (!remain.bare.length) {
                    return `补充失败：剩余文本是空的（${remainPath}），没有可提取的句子。`
                }

                // ── 2. 一次调用：题目 + 归类 ──
                const numbered = remain.bare.map((s, i) => `${i + 1}. ${s}`).join('\n')
                const r = await callModel(ctx, exec, SYSTEM, [
                    `题目：${input}`,
                    '',
                    `【剩余文本】共 ${remain.bare.length} 句`,
                    numbered,
                ].join('\n'))
                if (!r.ok) return `补充失败：${r.error}`

                let parsed
                try {
                    parsed = parseClaim(r.text)
                } catch (err) {
                    return `补充失败：${err?.message ?? err}`
                }

                // ── 3. 题名与落点：题目就是词名，模型无权改写 ──
                const title = titleFromTopic(input)
                if (!title) return '补充失败：题目清洗后为空，无法给注释表命名'

                const resolved = resolveClaims(remain.bare, parsed.matches, title)
                const taken = resolved.claimed.size
                const left = remain.lines.length - taken

                const notePath = String(args?.out ?? '').trim()
                    || path.join(root, OUT_DIR, `${title}${NOTE_SUFFIX}`)
                const recordPath = String(args?.outRecord ?? '').trim()
                    || path.join(root, RECORD_NAME)

                if (!resolved.entry) {
                    return renderPanel({
                        title,
                        entry: null,
                        taken,
                        left,
                        paths: { note: notePath, remain: remainPath, record: null },
                        dropped: resolved,
                    })
                }

                const annotation = renderAnnotation([resolved.entry])
                const remainingText = renderRemaining(remain.lines, resolved.claimed)

                // ── 4. 落盘：注释表 → 剩余文本 → 记录 ──
                try {
                    await fs.mkdir(path.dirname(notePath), { recursive: true })
                    await fs.writeFile(notePath, annotation, 'utf-8')
                } catch (err) {
                    return `补充失败：注释表写不进（${notePath}）\n${err?.message ?? err}\n剩余文本未改动。`
                }

                try {
                    await fs.writeFile(remainPath, remainingText, 'utf-8')
                } catch (err) {
                    return [
                        '补充失败：剩余文本写不回，但注释表已落盘',
                        String(err?.message ?? err),
                        `注释表：${notePath}`,
                        `剩余文本仍是原样：${remainPath}（同一句现在两处都有，下轮 dieci 前请手工核对）`,
                    ].join('\n')
                }

                const recorded = await appendRecord(recordPath, recordLine(
                    'supplement',
                    title,
                    `取走 ${taken} 句\t剩余 ${left} 句`,
                ))

                return renderPanel({
                    title,
                    entry: resolved.entry,
                    taken,
                    left,
                    paths: { note: notePath, remain: remainPath, record: recorded ? recordPath : null },
                    dropped: resolved,
                })
            } catch (err) {
                return `补充失败：${err?.message ?? err}`
            }
        },
    })
}
