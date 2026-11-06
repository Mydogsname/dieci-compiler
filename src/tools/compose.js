import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callModel } from '../core/llm.js'
import { OUT_DIR, PLAIN_SUFFIX, workspaceRoot } from '../core/paths.js'
import { ok, fail, TEXT_OUTPUT } from '../core/result.js'
import { workspaceName, uncoveredSpans, unsourcedConstraints, themeFileName } from '../core/text.js'

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
 * 成品首行是「主题：…」——不给 theme 时主题只能由注释里出现过的词组成，用来约束成稿不跑题；
 * 给了 theme 就把那句写死当首行，模型只负责把正文写紧扣，不得改主题的措辞。
 */

/** 成品首行的主题行 */
const THEME_LINE = /^主题[:：]\s*(.+)$/u

/** 用户写主题时常带的前缀，读入时剥掉 */
const THEME_PREFIX = /^主题[:：]\s*/u

/** 指定主题的长度上限（成品首行要能一行放下） */
const THEME_MAX = 200

/** 注释里的条目行：顶格的「词：」；缩进行是续行 */
const ENTRY_LINE = /^([^：:\s][^：:]{0,19})[:：]\s*\S/u

/**
 * 成稿器的系统提示。
 * 主题由谁定，决定任务第 1 步是「拟定」还是「照办」：
 *   · givenTheme 为空 —— 模型自己定主题（缺省行为，与旧版输出逐字相同）；
 *   · givenTheme 有值 —— 主题已经定了，模型只负责把产物写紧扣，且不得改主题的措辞；
 *     此时第 2 步不再写死「散文」，产物形态交给模型按主题判断。
 * @param {string} givenTheme 用户指定的主题（已归一）；空串表示由模型自定
 * @returns {string}
 */
function systemFor(givenTheme) {
    const themeStep = givenTheme
        ? `1. 主题已由用户指定：「${givenTheme}」。你不要另行拟定，也不要改动它的措辞；产物必须紧扣这个主题。`
        : '1. 定主题：一句话，必须由注释里出现过的词组合而成，不许引入注释中没有的实体、风格或情绪。'

    const formStep = givenTheme
        ? '2. 产物形态由主题决定：先判断这句主题要的是哪种产物，再按那种产物本来的样子写。形态只服从两处依据——主题本身，以及原料里的规格注释；原料里有规格注释就照它，没有就按该产物通常的规矩来。不要预设某一种形态。'
        : '2. 写成稿正文：一段或几段连贯、可直接使用的中文文字。'

    return `你是成稿器。用户给你两块原料，此外没有别的材料。

【注释】一个词一条，词后面是与之相关的原句；两空格缩进的续行属于同一条。
【剩余文本】不属于任何词的零散句子，括号里是来源文件。

任务：
${themeStep}
${formStep}

成稿规则：
- 只能使用这两块原料里出现过的事实与用词；不得新增人物、物件、风格词、细节或常识。
- 原料里的否定约束必须原样保留其含义，不得丢弃或弱化；原料里没有的约束，一个字都不要加。
- 注释内部若互相矛盾，选与主题最契合的一支，成稿只表达这一支，不要含混并置。
- 可以调整语序、合并、补连接词与标点，让文字连贯。
- 正文里不写标题、不解释、不提到「注释」「剩余文本」「素材」这类元信息。

**舍弃要说清**：你按主题砍掉了哪一支，就逐条报出来——砍的是什么（原料里的哪个词、哪些句子所属的那一类），为什么砍（与主题或与哪条约束冲突）。没砍就报空数组。这些只进面板给用户看，不进正文。

直接输出 JSON：
{ "theme": "${givenTheme ? '原样回传用户指定的主题，一个字都不要改' : '主题'}", "body": "${givenTheme ? '产物正文' : '成稿正文'}", "dropped": [ { "what": "被舍弃的部分", "why": "为什么舍弃" } ] }`
}

/**
 * 归一用户给的 theme：换行并成空格、去「主题：」前缀、去首尾空白。
 * 成品首行必须能一行放下，所以这里就把多行压平。
 * @param {unknown} raw
 * @returns {string} 归一后的主题；空串表示没指定
 */
function normalizeTheme(raw) {
    const flat = String(raw ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .join(' ')
        .trim()
        .replace(/[ \t\u3000]+/gu, ' ')
    return flat.replace(THEME_PREFIX, '').trim()
}

/**
 * 主题是不是同一句：忽略空白、末尾标点、以及模型可能带回的「主题：」前缀。
 * 模型在 temperature 0 下也常给你补个句号，不该因此报「与指定不符」。
 */
function sameTheme(a, b) {
    const norm = (s) => String(s ?? '')
        .replace(THEME_PREFIX, '')
        .replace(/\s+/gu, '')
        .replace(/[。.！!？?，,、；;：:]+$/u, '')
    return norm(a) === norm(b)
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
        if (v.theme !== undefined && typeof v.theme !== 'string') throw new Error('theme 不是字符串')
        if (typeof v.body !== 'string' || !v.body.trim()) throw new Error('body 缺失或为空')
        const dropped = Array.isArray(v.dropped) ? v.dropped : []
        for (const [i, d] of dropped.entries()) {
            if (!d || typeof d !== 'object') throw new Error(`dropped[${i}] 不是对象`)
        }
        return {
            theme: typeof v.theme === 'string' ? v.theme.trim().replace(THEME_PREFIX, '') : '',
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
- theme：指定主题，可选。给了就不再让模型自定，成品首行逐字用这句（剥「主题：」前缀、多行压成一行），
    模型只负责把产物写紧扣，产物形态由模型按主题判断（要提示词就出提示词，要文章就出文章）；
    主题里含注释表外的词只面板标注，不阻断。
- out：成品落盘路径，可选。**不传就固定落到 <工作区>\\叠词\\<工作区名>[-<主题>].txt**——
    成品总要落盘，不允许「只返回文本、磁盘上没有」。
【原料边界】
- 只有注释表与剩余文本两块，不读源文件、不读语义文件、不重新配对。
- 成品首行「主题：…」；不给 theme 时主题只能由注释表里出现过的词组成。
【纪律】
- 注释表里没有注释条目时直接报错，不猜。
- 主题逐成分核对：先按注释词切，切剩的每段再回原料（注释表 + 剩余文本）里找；找不到的逐条列出。
- 不给 theme 时，主题含表外成分只面板告警，不改动成品。
- 给了 theme 时人工指定优先：表外成分只标注，不改写你写的字。`,
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
            theme: {
                type: 'string',
                description: '指定主题（可选）：给了就写死成品首行，模型不再自定；表外成分逐条标注，不阻断',
            },
            out: {
                type: 'string',
                description: '成品落盘路径（可选；缺省 <工作区>\\叠词\\<工作区名>[-<主题>].txt，永远会落盘）',
            },
        },
        output: TEXT_OUTPUT,

        async execute(args, exec) {
            try {
                let outArg = String(args?.out ?? '').trim()
                if (outArg && !path.isAbsolute(outArg)) {
                    return fail(`成稿失败：out 必须是绝对路径（${outArg}）`)
                }

                // 指定主题：归一后非空才算「用户定了主题」
                const givenTheme = normalizeTheme(args?.theme)
                if (givenTheme.length > THEME_MAX) {
                    return fail(`成稿失败：theme 太长（上限 ${THEME_MAX} 字，收到 ${givenTheme.length} 字）`)
                }

                const root = workspaceRoot(exec, ctx)

                // 成品固定落到 <工作区>\叠词\ 下；没给 out 就按主题算一个。
                // out 若是可选且真跳过写盘，调用方漏一次就只在返回里给文本、磁盘上什么都没有。
                if (!outArg) {
                    const name = givenTheme
                        ? `${workspaceName(root)}-${themeFileName(givenTheme)}`
                        : workspaceName(root)
                    outArg = path.join(root, OUT_DIR, `${name}.txt`)
                }

                // ── 1. 定注释表：显式传入的优先，否则扫 叠词\ ──
                const given = []
                const arr = args?.notes
                if (Array.isArray(arr)) {
                    for (const p of arr) {
                        const v = String(p ?? '').trim()
                        if (!v) continue
                        if (!path.isAbsolute(v)) return fail(`成稿失败：notes 里必须全是绝对路径（${v}）`)
                        given.push(v)
                    }
                }
                const single = String(args?.note ?? '').trim()
                if (single) {
                    if (!path.isAbsolute(single)) return fail(`成稿失败：note 必须是绝对路径（${single}）`)
                    given.push(single)
                }

                let notePaths = given
                if (!notePaths.length) {
                    notePaths = await scanNotes(root)
                    if (!notePaths.length) {
                        return fail(`成稿失败：${path.join(root, OUT_DIR)} 下没有任何注释表（*-注释.txt）。请先跑 /dieci 或 /supplement。`)
                    }
                }
                notePaths = [...new Set(notePaths)]

                // ── 2. 读注释表，按叠层顺序拼接 ──
                const parts = []
                for (const p of notePaths) {
                    const raw = await fs.readFile(p, 'utf-8').catch(() => null)
                    if (raw === null) return fail(`成稿失败：注释表读不了（${p}）`)
                    if (!raw.trim()) return fail(`成稿失败：注释表是空的（${p}）`)
                    parts.push({ path: p, text: raw.trim() })
                }

                const allTerms = [...new Set(parts.flatMap(p => noteTerms(p.text)))]
                if (!allTerms.length) {
                    return fail(`成稿失败：注释表里没有注释条目（${notePaths.join('、')}）。请先跑 /dieci 或 /supplement。`)
                }

                // ── 3. 读剩余文本（缺省 <工作区>\<工作区名>-剩余.txt；不存在按空处理）──
                let residualPath = String(args?.residual ?? '').trim()
                if (residualPath && !path.isAbsolute(residualPath)) {
                    return fail(`成稿失败：residual 必须是绝对路径（${residualPath}）`)
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

                const r = await callModel(ctx, exec, systemFor(givenTheme), prompt)
                if (!r.ok) return fail(`成稿失败：${r.error}`)

                // ── 5. 解析成品：主题 + 正文 + 舍弃清单 ──
                const { theme: modelTheme, body, dropped, json } = parseProduct(r.text)
                if (!body) return fail(`成稿失败：模型没有给出正文\n原始输出：${r.text.slice(0, 400)}`)

                // 主题优先用用户指定的那句，一个字不改
                const theme = givenTheme || modelTheme
                const productText = theme ? `主题：${theme}\n\n${body}\n` : body + '\n'

                // ── 6. 落盘（outArg 此时一定有值）──
                try {
                    await fs.mkdir(path.dirname(outArg), { recursive: true })
                    await fs.writeFile(outArg, productText, 'utf-8')
                } catch (err) {
                    return fail(`成稿失败：成品写不进（${outArg}）\n${err?.message ?? err}\n正文见下：\n\n${productText}`)
                }

                // ── 7. 回报 ──
                const material = [...parts.map(p => p.text), residualText].join('\n')
                const notes = []
                if (!json) notes.push('模型没按 JSON 输出，舍弃清单缺失（其余照常）')
                if (givenTheme && modelTheme && !sameTheme(givenTheme, modelTheme)) {
                    notes.push(`模型自拟的主题与指定不符，已按你给的原样写入；模型给的是：${modelTheme}`)
                }
                if (!theme) notes.push('主题既没有指定、模型也没给出，成品只有正文')
                else {
                    const stray = uncoveredSpans(theme, allTerms, material)
                    if (stray.length) {
                        notes.push(givenTheme
                            ? `主题里这些成分注释表和剩余文本都没有（成稿可能据此编造），已按你给的原文落盘：${stray.join('、')}`
                            : `主题里这些成分注释表和剩余文本都没有，请核对：${stray.join('、')}`)
                    }
                }

                // 正文核对：主题对过账了，捏造的禁止项也要对——它会改变「不能画什么」
                const unsourced = unsourcedConstraints(body, material)
                if (unsourced.length) {
                    notes.push(`正文里这些否定约束原料中找不到（可能是编造的，请核对）：${unsourced.join(' / ')}`)
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

                return ok([
                    productText.trimEnd(),
                    '',
                    `已落盘：${outArg}`,
                    `原料：${parts.length} 层注释（${parts.map(p => path.basename(p.path)).join(' / ')}）${residualText ? ' + 剩余文本' : ''}`,
                    `主题：${givenTheme ? '用户指定' : modelTheme ? '模型自定' : '无'}`,
                    ...droppedLines,
                    ...notes.map(n => `注：${n}`),
                ].join('\n'))
            } catch (err) {
                return fail(`成稿失败：${err?.message ?? err}`)
            }
        },
    })
}
