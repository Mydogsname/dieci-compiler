/**
 * 叠词编译器的纯文本判据：不碰 fs、不调模型，便于单测。
 *
 * 契约（与 decompose 的 SYSTEM 提示词一一对应）：
 *   1. 一句一行：语义文件每个非空行 = 正文按 。！？； 切出的一句，次序一致
 *   2. 保真：行内文字与对应源句逐字相同（忽略空白差异）
 *   3. 组间空行：同一方面的相邻句归一组，组与组之间恰好一个空行
 *   4. 覆盖：源文每句都入语义文件，不多不少、不重复
 *
 * 判据按「行位」比对，因此合并、拆分、换序、重复、塞碎片都会被指出来。
 */

import { ILLEGAL_IN_NAME } from './paths.js'

const FENCE = /^```/u

/** 归一化空白：压成一个空格、去首尾、去 BOM */
export function normalizeWs(s) {
    return String(s ?? '').replace(/\uFEFF/gu, '').replace(/\s+/gu, ' ').trim()
}

/** 完全忽略空白的比较口径（字本位：一个字都不能多、不能少） */
export function squash(s) {
    return normalizeWs(s).replace(/ /gu, '')
}

/** 按句切分：。！？； 结束处切一刀，硬换行也切。与落盘行一一对应。 */
export function splitSentences(text) {
    return String(text ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/\uFEFF/gu, '')
        .split(/(?<=[。！？；\n])/u)
        .map(s => normalizeWs(s))
        .filter(Boolean)
}

/**
 * 模型输出 → 行数组：去代码块围栏，去首尾空行，组内连续空行压成一个。
 * 返回里保留空行——空行即组界。
 */
export function parseSemantic(text) {
    const lines = String(text ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map(l => l.trim())
        .filter(l => !FENCE.test(l))

    while (lines.length && !lines[0]) lines.shift()
    while (lines.length && !lines[lines.length - 1]) lines.pop()

    const out = []
    for (const l of lines) {
        if (!l && out[out.length - 1] === '') continue
        out.push(l)
    }
    return out
}

/** 行数组 → 分组（空行即组界） */
export function toGroups(lines) {
    const groups = []
    let cur = []
    for (const l of lines) {
        if (!l) {
            if (cur.length) groups.push(cur)
            cur = []
            continue
        }
        cur.push(l)
    }
    if (cur.length) groups.push(cur)
    return groups
}

/** 行数组 → 落盘文本（组间一个空行，末尾一个换行） */
export function renderSemantic(lines) {
    return toGroups(lines).map(g => g.join('\n')).join('\n\n') + '\n'
}

/**
 * 检查一份语义文本是否符合契约。
 * @returns {{
 *   ok: boolean,
 *   bad: string[],       行内容与对应源句不符（改字/编造/多出的行/错位）
 *   missing: string[],   源文有、语义文件缺的句子
 *   problems: string[],  结构性毛病（行数不符/一行多句/连续空行/重复行）
 *   lines: string[],     语义文件的有效行
 *   groups: string[][],  分组结果
 *   sentenceCount: number, noteCount: number, groupCount: number,
 * }}
 */
export function checkNotes(body, noteText) {
    const sentences = splitSentences(body)
    const lines = parseSemantic(noteText)
    const units = lines.filter(Boolean)
    const groups = toGroups(lines)

    const bad = []
    const missing = []
    const problems = []

    if (!units.length) problems.push('语义文件没有有效行')
    if (units.length !== sentences.length) {
        problems.push(`行数与源句数不符：语义 ${units.length} 行，源文 ${sentences.length} 句`)
    }

    // ── 逐行按位置比对：顺序错位也会落进 bad ──
    const total = Math.max(units.length, sentences.length)
    for (let i = 0; i < total; i++) {
        const line = units[i]
        const sent = sentences[i]
        if (line && sent) {
            const inner = splitSentences(line)
            if (inner.length > 1) {
                problems.push(`第 ${i + 1} 行含 ${inner.length} 句（应一句一行）：${line}`)
            }
            if (squash(line) !== squash(sent)) bad.push(`${line}（应为：${sent}）`)
        } else if (line) {
            bad.push(`${line}（源文没有对应句）`)
        } else if (sent) {
            missing.push(sent)
        }
    }

    // ── 重复行 ──
    const seen = new Map()
    for (const l of units) {
        const k = squash(l)
        if (!seen.has(k)) seen.set(k, { text: l, count: 0 })
        seen.get(k).count++
    }
    for (const { text, count } of seen.values()) {
        if (count > 1) problems.push(`重复行 ${count} 次：${text}`)
    }

    // ── 组界：连续空行 ──
    const raw = String(noteText ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/\uFEFF/gu, '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => !FENCE.test(l))
    let prevBlank = false
    for (let i = 0; i < raw.length; i++) {
        const blank = raw[i] === ''
        const edge = i === 0 || i === raw.length - 1
        if (blank && prevBlank && !edge) {
            problems.push(`第 ${i + 1} 行是连续空行（组间只空一行）`)
        }
        prevBlank = blank
    }

    const dedupe = arr => [...new Set(arr)]

    return {
        ok: bad.length === 0 && missing.length === 0 && problems.length === 0,
        bad: dedupe(bad),
        missing,
        problems: dedupe(problems),
        lines: units,
        groups,
        sentenceCount: sentences.length,
        noteCount: units.length,
        groupCount: groups.length,
    }
}

// ─── 路径推导：decompose / check_notes / dieci 共用同一规则 ───

/** 源文件名 → 主名（去掉一层文本后缀） */
export function sourceBaseName(file) {
    const base = String(file ?? '').split(/[\\/]/u).pop() ?? ''
    return base.replace(/\.(txt|md|markdown|text)$/iu, '')
}

/** 源文件 → 语义文件路径：同目录/语义/<主名>-语义.txt */
export function semanticPathFor(file, path) {
    return path.join(path.dirname(file), '语义', `${sourceBaseName(file)}-语义.txt`)
}

/**
 * 工作区名字：取根目录的目录名，当作产物的名字前缀。
 * 会话头里没有工作区标题（SessionHeader 只有 cwd），所以名字只能从 cwd 取。
 * @param {string} root 工作区绝对路径
 * @returns {string} 清洗过的目录名；取不到时回落字面量 '工作区'
 */
export function workspaceName(root) {
    const raw = sourceBaseName(String(root ?? '').replace(/[\\/]+$/u, ''))
    const cleaned = raw
        .replace(ILLEGAL_IN_NAME, '')
        .replace(/\s+/gu, ' ')
        .trim()
    return cleaned || '工作区'
}

/**
 * 用主题本身当成品文件名：剥掉文件名非法字符，压空白，过长截断。
 * compose 的缺省落点要用它，命令侧也用它——两边算出的名字必须一致。
 * @param {string} theme 主题
 * @returns {string} 干净的文件名片段；主题全被剥光时回落「指定主题」
 */
export function themeFileName(theme) {
    const cleaned = String(theme ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 40)
    return cleaned || '指定主题'
}

// ─── 主题核对：compose 出成品前校验主题有没有跑出注释表 ───

/** 切主题时不计入成分的字符：标点与空白 */
const SPAN_NOISE = /[\s。，、；：！？…—－·“”‘’（）《》〈〉「」『』【】,.．;:!?()"'\-]/gu

/**
 * 主题里「既不是注释词、又没在原料里出现过」的成分。
 *
 * 旧规则是「主题含任意一个词就放行」——主题「金鱼配红烧肉」因为含「金鱼」就过了，
 * 成品随后就敢编红烧肉。这里改成逐段核对：
 *   1. 从左到右扫主题，能匹配上某个注释词的原样跳过（长词优先，免得「黑色扩散」被「黑色」切碎）；
 *   2. 连续匹配不上的字聚成一段，去掉标点空白；
 *   3. 这一段在原料（注释表 + 剩余文本全文）里找得到，就算原料覆盖；
 *   4. 找不到的才算表外成分，报出来。
 *
 * 只报不拦：主题是用户写的，工具只负责告诉用户哪几个字没有依据。
 *
 * @param {string} theme 成品首行的主题
 * @param {string[]} terms 注释表里的词
 * @param {string} material 原料全文（注释表 + 剩余文本）
 * @returns {string[]} 表外成分，按出现顺序、去重
 */
export function uncoveredSpans(theme, terms, material) {
    const sorted = [...new Set((terms ?? []).filter(Boolean))].sort((a, b) => b.length - a.length)
    const spans = []
    let rest = ''

    for (let i = 0; i < theme.length;) {
        const hit = sorted.find(t => theme.startsWith(t, i))
        if (hit) {
            if (rest) { spans.push(rest); rest = '' }
            i += hit.length
            continue
        }
        rest += theme[i]
        i++
    }
    if (rest) spans.push(rest)

    const out = []
    for (const span of spans) {
        const cleaned = span.replace(SPAN_NOISE, '')
        if (!cleaned) continue
        if (material.includes(cleaned)) continue
        if (!out.includes(cleaned)) out.push(cleaned)
    }
    return out
}

// ─── 正文核对：compose 出成品后查一遍「捏造的禁止项」 ───

/** 否定词：带这些词的句子，改一个字就改变「不能画什么」 */
const NEGATION = /(?:不要|不能|不得|禁止|避免|排除|勿)[^；。！？\n]*/gu

/** 去掉标点与空白，只留字——两边比对前都走一遍 */
const plain = s => squash(s).replace(SPAN_NOISE, '')

/**
 * 正文里「原料中找不到的否定约束」。
 *
 * 主题有 uncoveredSpans 对账，正文之前没人管。正文里真正致命的是**捏造的禁止项**：
 * 实测有一份成品写着「负面提示：排除模糊、畸形、水印等不希望出现的内容；不要人物。」，
 * 而「不要人物」四个字整份原料里根本没有——它来自 compose 自己的提示词举例，
 * 被模型当成原料抄了进去（提示词已改，这里是兜底）。
 *
 * 一条捏造的否定约束会让图少画东西、让人多删东西，读完不细看根本察觉不到。
 *
 * 只比对**否定短语**（否定词后面到句末），不比对整句——compose 补个「用来」之类的
 * 虚词是允许的，整句比对会把这种正常改写判成编造。
 * 也不查普通的用词组装：把词拼成句本来就是 compose 的活，那种检查全是噪声。
 *
 * @param {string} body 成品正文
 * @param {string} material 原料全文（注释表 + 剩余文本）
 * @returns {string[]} 找不到出处的否定短语，去重
 */
export function unsourcedConstraints(body, material) {
    const src = plain(material)
    const out = []

    for (const [phrase] of String(body ?? '').matchAll(NEGATION)) {
        const cleaned = plain(phrase)
        if (cleaned.length < 2) continue
        if (src.includes(cleaned)) continue
        if (!out.includes(cleaned)) out.push(cleaned)
    }
    return out
}
