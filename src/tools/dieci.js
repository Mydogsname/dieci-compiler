import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callModel } from '../core/llm.js'
import { ok, fail, TEXT_OUTPUT } from '../core/result.js'
import { checkNotes, semanticPathFor } from '../core/text.js'

/**
 * dieci —— 多份语义文件 → 两份数据文件。
 *
 *   1. 注释：逐行「词：原句」，同词多句两空格缩进续行。逐字取自语义文件，不加工。
 *   2. 剩余文本：没被任何词引用的句子，一行一句，前置（来源文件）。
 *
 * 本工具只出数据，不写成稿——成稿由 compose 读这两份文件产出。
 *
 * 纪律（代码强制）：
 *   · 模型只报 {src, s} 序号，原句由本工具回填，杜绝改字；
 *   · 同一句只能属于一个注释：先到先得，后到的丢弃并计数；
 *   · 只有 1 句依据的词丢弃；越界引用丢弃；
 *   · 统计、歧义、丢弃计数只回面板，不写进文件。
 *
 * 推理档位：这类任务不需要思考，而推理 token 与正文共享 maxTokens——会话
 * reasoningEffort=high 时模型会把配额全花在思考上。所以显式请求 off，不支持则回退。
 */

const SYSTEM_MATCH = `你是叠词器。读多份已编号的语义文件，跨文件建立词与句子的关联。

素材形如【素材 3：文件名.md】下面若干行「序号. 原句」。序号只在本文档内有效。

规则：
1. 词必须是实体或属性名词，2~8 字；不许用整句、从句、动宾短语当词。
2. 词必须能在原句里看到依据，不得凭空编造。
3. 一个词至少要有 2 条配对，否则不收录——单条依据只是标签，不是关联。
4. 同一实体的不同侧面合并成一个词，不许把一个实体拆成多个词。
5. 词的依据是句子在讲什么，不是句中出现过这个词的字面。
6. 「讲什么」取陈述对象，不取句子的语法主语。本体承前省略的，认前面被描述的那个东西为陈述对象，不按喻体的字面算。
   比喻、通感都按这个口径：喻体与本体本就不是一回事，喻体只是用来讲本体的；只要陈述对象相同，就算同指。
7. 对每个词，在其他素材里找语义相关的句子，也找本素材内相关的句子。
8. 相关性按语义判断，不只看字符串是否相同。
9. 引用句子只写序号：{"src": 素材序号, "s": 句序号}。绝不要抄写原句。
10. 同一句最多归到一个词下，不要跨词重复引用。
11. 量的上限：最多 15 个词，每个词最多 5 条配对。宁少不滥。
12. 直接输出 JSON 本身：不解释、不写过渡句、不复述规则。

输出字段：
- entries：array，每项 { "term": 词, "matches": [{ "src": 素材序号, "s": 句序号 }] }
- ambiguities：array，每项 { "part": 有歧义的部分, "could_mean": [可能的意思] }`

const DIRECTIONS = ['entity', 'topic', 'attribute']

// ─── 解析 JSON ───
function parsePairs(raw) {
    const check = (v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('顶层不是对象')
        if (!Array.isArray(v.entries)) throw new Error('entries 不是数组')

        for (const [i, e] of v.entries.entries()) {
            if (!e || typeof e !== 'object') throw new Error(`entries[${i}] 不是对象`)
            if (typeof e.term !== 'string' || !e.term.trim()) {
                throw new Error(`entries[${i}].term 缺失或为空`)
            }
            if (!Array.isArray(e.matches)) throw new Error(`entries[${i}].matches 不是数组`)
            for (const [j, m] of e.matches.entries()) {
                if (!m || typeof m !== 'object') throw new Error(`entries[${i}].matches[${j}] 不是对象`)
                if (!Number.isInteger(m.src) || !Number.isInteger(m.s)) {
                    throw new Error(`entries[${i}].matches[${j}] 必须写成 {"src": 素材序号, "s": 句序号}`)
                }
            }
        }

        const ambiguities = v.ambiguities ?? []
        if (!Array.isArray(ambiguities)) throw new Error('ambiguities 不是数组')
        for (const [i, a] of ambiguities.entries()) {
            if (!a || typeof a !== 'object') throw new Error(`ambiguities[${i}] 不是对象`)
            if (typeof a.part !== 'string' || !a.part.trim()) throw new Error(`ambiguities[${i}].part 缺失`)
            if (!Array.isArray(a.could_mean) ||
                a.could_mean.some(s => typeof s !== 'string' || !s.trim())) {
                throw new Error(`ambiguities[${i}].could_mean 不是字符串数组`)
            }
        }

        return { entries: v.entries, ambiguities }
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

// ─── 序号回填 + 全局独占 ───
/**
 * 把 { src, s } 换成原句，并落实硬约束。
 * @returns {{ entries: any[], ambiguities: any[], claimed: Set<string>, outOfRange: number, shared: number, thin: number }}
 */
function resolveRefs(loaded, parsed) {
    let outOfRange = 0
    let shared = 0
    let thin = 0
    const claimed = new Set()
    const entries = []

    for (const e of parsed.entries) {
        const mine = new Set()
        const matches = []
        for (const m of e.matches) {
            const mat = loaded[m.src - 1]
            const sentence = mat?.lines[m.s - 1]
            if (!mat || typeof sentence !== 'string') {
                outOfRange++
                continue
            }
            const key = `${m.src}:${m.s}`
            if (mine.has(key)) continue
            if (claimed.has(key)) {
                shared++
                continue
            }
            mine.add(key)
            matches.push({ sentence, source: mat.name, key })
        }

        if (matches.length < 2) {
            thin++
            continue
        }
        for (const m of matches) claimed.add(m.key)
        entries.push({ term: e.term.trim(), matches })
    }

    return { entries, ambiguities: parsed.ambiguities, claimed, outOfRange, shared, thin }
}

/**
 * 没被任何词认领的句子，按素材顺序收集——剩余文本文件的来源。
 * @returns {Array<{ source: string, sentence: string }>}
 */
function collectLeftovers(loaded, claimed) {
    const out = []
    loaded.forEach((m, i) => {
        m.lines.forEach((line, j) => {
            if (!claimed.has(`${i + 1}:${j + 1}`)) out.push({ source: m.name, sentence: line })
        })
    })
    return out
}

// ─── 渲染 ───
/**
 * 注释正文：一个词一条，首句跟在「词：」后，其余句子两空格缩进作续行。
 * 不写标题、不写统计、不写来源——这个文件只表达「哪些句子属于同一个词」。
 */
function renderAnnotation(resolved) {
    const lines = []
    for (const e of resolved.entries) {
        e.matches.forEach((m, i) => {
            lines.push(i === 0 ? `${e.term}：${m.sentence}` : `  ${m.sentence}`)
        })
    }
    return lines.length ? lines.join('\n') + '\n' : ''
}

/**
 * 剩余文本正文：一行一句，前置（来源文件），原样不改。
 */
function renderResidual(leftovers) {
    return leftovers.length
        ? leftovers.map(l => `（${l.source}）${l.sentence}`).join('\n') + '\n'
        : ''
}

/** 面板：统计、歧义、丢弃计数、落盘路径。元信息一律不进文件。 */
function renderPanel(loaded, resolved, leftovers, paths) {
    const pairs = resolved.entries.reduce((n, e) => n + e.matches.length, 0)
    const lines = [
        `已配对 ${loaded.length} 份语义文件：${loaded.map(m => m.name).join(' / ')}`,
        `注释：${resolved.entries.length} 个词、${pairs} 条（每句只归一个词）。`,
        `剩余文本：${leftovers.length} 句未被引用。`,
    ]

    if (!resolved.entries.length) lines.push('', '未形成任何词的关联，注释为空。')

    if (resolved.ambiguities.length) {
        lines.push('', '歧义：')
        for (const a of resolved.ambiguities) {
            lines.push(`- ${a.part}：${a.could_mean.join(' / ')}`)
        }
    }

    const notes = []
    if (resolved.shared) notes.push(`丢弃 ${resolved.shared} 条跨词共用引用（同一句只归一个注释）`)
    if (resolved.thin) notes.push(`丢弃 ${resolved.thin} 个只有 1 句的词`)
    if (resolved.outOfRange) notes.push(`丢弃 ${resolved.outOfRange} 条越界引用`)
    if (notes.length) lines.push('', ...notes.map(n => `注：${n}`))

    if (paths.outNote) lines.push('', `注释已落盘：${paths.outNote}`)
    if (paths.outResidual) lines.push(`剩余文本已落盘：${paths.outResidual}`)
    return lines.join('\n')
}

// ─── 工具工厂 ───
export function makeDieciTool({ ctx } = {}) {
    return defineTool({
        name: 'dieci',
        description: `叠词（dieci）：读多份已划分的语义文件，产出「注释」与「剩余文本」两份数据文件。
【参数】
- materials：源文件绝对路径数组，至少 2 个。工具自动推导 语义/<主名>-语义.txt。
- direction：配对维度，可选：entity（按实体）、topic（按主题）、attribute（按属性）；不传由模型从素材推断。
- out：注释文件落盘路径（可选）。
- outResidual：剩余文本文件落盘路径（可选；只给 out 时派生为同目录 <主名>-剩余.txt）。
【产物】
- 注释：逐行「词：原句」，同词多句两空格缩进续行。逐字取自语义文件，不加工。
- 剩余文本：没被任何词引用的句子，一行一句，前置（来源文件）。
【纪律】
- 模型只报 {src, s} 序号，原句由工具回填，杜绝改字。
- 同一句只能属于一个注释，重复引用丢弃。
- 只有 1 句依据的词丢弃；越界引用丢弃。
- 统计、歧义、丢弃计数只回面板，不写进文件。
- 本工具不出成稿；成稿请调用 compose。`,
        parameters: {
            materials: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '源文件绝对路径数组，至少 2 个；工具自动推导对应的 语义/<主名>-语义.txt',
            },
            direction: {
                type: 'string',
                description: '配对维度，可选：entity / topic / attribute；不传由模型从素材推断',
            },
            out: {
                type: 'string',
                description: '注释文件落盘路径（可选）',
            },
            outResidual: {
                type: 'string',
                description: '剩余文本文件落盘路径（可选）',
            },
        },
        output: TEXT_OUTPUT,

        async execute(args, exec) {
            try {
                const materials = args?.materials ?? []
                if (!Array.isArray(materials) || materials.length < 2) {
                    return fail('叠合失败：至少需要 2 份素材文件')
                }
                if (materials.some(p => !path.isAbsolute(String(p ?? '').trim()))) {
                    return fail('叠合失败：materials 里必须全是绝对路径')
                }

                const direction = String(args?.direction ?? '').trim()
                if (direction && !DIRECTIONS.includes(direction)) {
                    return fail(`叠合失败：direction 只能是 ${DIRECTIONS.join(' / ')}，收到「${direction}」`)
                }

                const outNote = String(args?.out ?? '').trim()
                if (outNote && !path.isAbsolute(outNote)) {
                    return fail(`叠合失败：out 必须是绝对路径（${outNote}）`)
                }

                let outResidual = String(args?.outResidual ?? '').trim()
                if (outResidual && !path.isAbsolute(outResidual)) {
                    return fail(`叠合失败：outResidual 必须是绝对路径（${outResidual}）`)
                }
                if (!outResidual && outNote) {
                    const base = path.basename(outNote).replace(/\.txt$/iu, '')
                    outResidual = path.join(path.dirname(outNote), `${base}-剩余.txt`)
                }

                // ── 1. 逐份复核语义文件，读出一句一行 ──
                const loaded = []
                for (const p of materials) {
                    const abs = String(p).trim()
                    const semPath = semanticPathFor(abs, path)
                    const semRaw = await fs.readFile(semPath, 'utf-8').catch(() => null)
                    if (semRaw === null) {
                        return fail(`叠合失败：${abs} 的语义文件不存在（${semPath}）。请先调用 decompose 生成。`)
                    }
                    if (!semRaw.trim()) {
                        return fail(`叠合失败：${abs} 的语义文件为空（${semPath}）。请重新调用 decompose。`)
                    }

                    const srcRaw = await fs.readFile(abs, 'utf-8').catch(() => null)
                    if (srcRaw === null) return fail(`叠合失败：源文件读不了（${abs}）`)

                    const r = checkNotes(srcRaw, semRaw)
                    if (!r.ok) {
                        return fail([
                            `叠合失败：${abs} 的语义文件检查未通过`,
                            r.bad.length ? `保真：${r.bad.length} 行对不上源文\n` + r.bad.map(l => `  · ${l}`).join('\n') : '',
                            r.missing.length ? `覆盖：缺 ${r.missing.length} 句\n` + r.missing.map(s => `  · ${s}`).join('\n') : '',
                            r.problems.length ? `结构：${r.problems.length} 处问题\n` + r.problems.map(s => `  · ${s}`).join('\n') : '',
                            '请重新调用 decompose 生成。',
                        ].filter(Boolean).join('\n'))
                    }

                    loaded.push({ name: path.basename(abs), lines: r.lines })
                }

                // ── 2. 配对 ──
                const materialsText = loaded
                    .map((m, i) => {
                        const numbered = m.lines.map((line, j) => `${j + 1}. ${line}`).join('\n')
                        return `【素材 ${i + 1}：${m.name}】\n${numbered}`
                    })
                    .join('\n\n')

                const directionLine = direction
                    ? `配对维度：${direction}`
                    : '未指定配对维度。请从素材推断最合适的配对维度。'

                const r = await callModel(ctx, exec, SYSTEM_MATCH, `${directionLine}\n\n${materialsText}`)
                if (!r.ok) return fail(`叠合失败：${r.error}`)

                let parsed
                try {
                    parsed = parsePairs(r.text)
                } catch (err) {
                    return fail(`叠合失败：${err?.message ?? err}`)
                }

                const resolved = resolveRefs(loaded, parsed)
                const leftovers = collectLeftovers(loaded, resolved.claimed)
                const annotation = renderAnnotation(resolved)
                const residual = renderResidual(leftovers)

                // ── 3. 落盘两份数据文件 ──
                if (outNote) {
                    await fs.mkdir(path.dirname(outNote), { recursive: true })
                    await fs.writeFile(outNote, annotation, 'utf-8')
                }
                if (outResidual) {
                    await fs.mkdir(path.dirname(outResidual), { recursive: true })
                    await fs.writeFile(outResidual, residual, 'utf-8')
                }

                const panel = renderPanel(loaded, resolved, leftovers, { outNote, outResidual })
                if (outNote) return ok(panel)

                return ok([
                    panel,
                    '',
                    '—— 注释 ——',
                    annotation.trimEnd() || '（空）',
                    '',
                    '—— 剩余文本 ——',
                    residual.trimEnd() || '（空）',
                ].join('\n'))
            } catch (err) {
                return fail(`叠合失败：${err?.message ?? err}`)
            }
        },
    })
}