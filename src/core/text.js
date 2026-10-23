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
