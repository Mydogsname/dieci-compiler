/**
 * 叠词文件解析器（纯函数、只读、零依赖）
 *
 * 文件格式：
 *   第 1 行          标题（独占一行，可有 "# " 前缀）
 *   第 2 行 ~ …      正文
 *   注释：            区标记，全角冒号，独占一行
 *   词：内容          注释条目（词 = 2-12 个中文/字母/数字/下划线，无标点空格，顶格）
 *     缩进 2 空格     上一条目的续行（续行 ≠ 条目；条目顶格，续行 ≥2 空格）
 *
 * 引用写在注释内容里（「见 文件:行」）。旧的「出处：」区已废弃：
 * 仍识别为终止标记，其内容不再解析，只产生一条警告。
 *
 * 无损保证：serialize(parse(text)._lines, lineEnding) === text（同质行尾文件逐字节还原）。
 */

export const RE_WORD = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,12}$/u

const WORD_PART = '[一-龥A-Za-z0-9_]{2,12}'
// 合法条目行：严格词 + 全角/半角冒号 + 内容
const RE_ENTRY = new RegExp(`^(${WORD_PART})[：:]\\s*(.*)$`, 'u')
// 续行：≥2 空格开头
const RE_CONT = /^\s{2,}(.*)$/
// "看起来像条目"的宽松检测（用于把词不合规的行挑出来报警）
const RE_LOOKS_ENTRY = /^\s*(\S[^：:\n]{0,30}?)[：:]/

/** 标记每一行是否处于 ``` 代码围栏内 */
function fenceMask(lines) {
    const inside = new Array(lines.length).fill(false)
    let fenced = false
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim()
        if (t.startsWith('```')) { inside[i] = true; fenced = !fenced; continue }
        inside[i] = fenced
    }
    return inside
}

/** 第 i 行的「注释：」是不是真区标记 —— 只看结构痕迹，不看注释内容是否合法 */
function isRealMarker(lines, i, n, inFence) {
    if (inFence[i]) return false                 // ① 它本身在代码块里 → 是正文举例
    for (let k = i + 1; k < n; k++) {
        const t = lines[k].trim()
        if (t === '出处：') return true           // 注释区到此为止
        if (t.startsWith('```')) return false     // ② 后面还有代码块 → 正文还在继续
        if (/^#{1,6}\s/.test(t)) return false     // ② 后面还有 Markdown 标题 → 同上
    }
    return true                                   // ③ 是标记；里面有什么行一概不管
}

/** 检测文件主行尾：CRLF 占多则 CRLF，否则 LF（无换行默认 LF） */
export function detectLineEnding(text) {
    let crlf = 0
    let lf = 0
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            if (text[i - 1] === '\r') crlf++
            else lf++
        }
    }
    return crlf > lf ? 'CRLF' : 'LF'
}

/** 按主行尾把行数组拼回文本 */
export function serialize(lines, lineEnding) {
    return lines.join(lineEnding === 'CRLF' ? '\r\n' : '\n')
}

/**
 * 解析叠词文件。
 * @param {string} text 原始文件内容
 * @returns {object} 见文件头注释 / 修改文档 §1.2 的契约
 */
export function parsePrompt(text) {
    const warnings = []
    const lineEnding = detectLineEnding(text)
    const eol = lineEnding === 'CRLF' ? '\r\n' : '\n'
    const lines = text.split(/\r\n|\r|\n/)
    const n = lines.length

    // ── 标题：第一个非空行 ──
    let titleLine = -1
    for (let i = 0; i < n; i++) {
        if (lines[i].trim() !== '') {
            titleLine = i
            break
        }
    }
    let title = ''
    let titleRaw = ''
    if (titleLine >= 0) {
        titleRaw = lines[titleLine]
        const m = titleRaw.match(/^#\s+(.*)$/)
        title = m ? m[1].trim() : titleRaw.trim()
        if (titleLine > 0) {
            warnings.push(`标题不在第 1 行（前面有 ${titleLine} 个空行）`)
        }
    }

    // ── 区标记：全角「注释：」「出处：」独占一行；半角只报警不当标记 ──
    // 判据只看结构痕迹（代码围栏 / 后面是否还有代码块或标题），不看注释区里的行合不合法：
    //   区里有不认识的行归 unparsed 记录 + 原样保留，不影响"这一行是不是区标记"（见 fenceMask / isRealMarker）
    const inFence = fenceMask(lines)
    let markerLine = -1
    let markerCount = 0
    let sourceMarkerLine = -1
    for (let i = 0; i < n; i++) {
        const t = lines[i].trim()
        if (t === '注释：') {
            markerCount++
            if (markerLine < 0) {
                if (isRealMarker(lines, i, n, inFence)) {
                    markerLine = i
                } else {
                    warnings.push(`第 ${i + 1} 行的「注释：」在代码块内（或它后面还有代码块/标题）—— 判为正文里的举例，不是注释区`)
                }
            }
        } else if (t === '注释:') {
            warnings.push(`第 ${i + 1} 行是半角冒号的「注释:」，不当区标记（请改成全角「注释：」）`)
        } else if (t === '出处：' && sourceMarkerLine < 0) {
            sourceMarkerLine = i
        }
    }
    if (markerCount === 0) {
        warnings.push('没有找到独占一行的「注释：」，注释区为空')
    } else if (markerCount > 1) {
        warnings.push(`文件里有 ${markerCount} 处「注释：」，按第一处切分；请确认正文里没有同形行`)
    }

    const ok = markerLine >= 0

    // 注释区从「注释：」下一行到文件末尾；旧的「出处：」若出现在其后，只作终止标记。
    const bodyStart = titleLine + 1
    const bodyEnd = markerLine >= 0 ? markerLine : n
    const bodyLines = lines.slice(bodyStart, bodyEnd)
    const body = bodyLines.join(eol)

    const legacySourceLine = sourceMarkerLine > markerLine ? sourceMarkerLine : -1
    if (legacySourceLine >= 0) {
        warnings.push(`第 ${legacySourceLine + 1} 行的「出处：」区已废弃，内容不再解析；引用请写进注释内容（见 文件:行）`)
    }
    const commentRange = markerLine >= 0
        ? [markerLine + 1, legacySourceLine >= 0 ? legacySourceLine : n]
        : null

    // ── 正文里形如条目的行 → 提示位置可能放错 ──
    // 长度闸门：中文散文里"短句：展开"很常见，整行 ≤30 字才警告（真误放通常是短行）
    const BODY_ENTRY_GATE = 30
    for (let i = bodyStart; i < bodyEnd; i++) {
        const raw = lines[i]
        if (raw.trim().length > BODY_ENTRY_GATE) continue
        const m = raw.match(new RegExp(`^(${WORD_PART})[：:]`, 'u'))
        if (m) {
            warnings.push(`正文第 ${i + 1} 行的「${m[1]}：」看起来像注释条目；若它该是注释，请放到「注释：」之后`)
        }
    }

    // ── 解析注释区 ──
    const comments = []
    const unparsed = []
    if (commentRange) {
        let current = null
        for (let i = commentRange[0]; i < commentRange[1]; i++) {
            const raw = lines[i]
            const trimmed = raw.trim()

            // 空行：原样保留，断开续行归属，不算未识别
            if (trimmed === '') {
                current = null
                continue
            }

            // 段内再次出现的区标记行：原样保留，绝不当条目
            //（"注释："本身会被 RE_ENTRY 误匹配为词"注释"的空条目）
            if (trimmed === '注释：' || trimmed === '出处：') {
                current = null
                continue
            }

            const m = raw.match(RE_ENTRY)
            if (m) {
                current = { word: m[1], content: m[2].trim(), lines: [i] }
                comments.push(current)
                continue
            }

            const c = raw.match(RE_CONT)
            if (c && current) {
                const inner = c[1]
                // 缩进内容若形如条目 → 报警（仍当续行处理，避免改变归属）
                if (RE_ENTRY.test(inner)) {
                    const preview = inner.length > 20 ? inner.slice(0, 20) + '…' : inner
                    warnings.push(
                        `第 ${i + 1} 行「${preview}」看起来是缩进的条目 —— 缩进表示它是上一条的续行；`
                        + '若想让它成为独立条目，请顶格写')
                }
                current.lines.push(i)
                current.content = current.content ? current.content + '\n' + inner : inner
                continue
            }

            // 无法识别：形如条目但词不合规要单独报警
            let reason = '无法识别的行'
            const looks = raw.match(RE_LOOKS_ENTRY)
            if (looks && !RE_WORD.test(looks[1].trim())) {
                reason = '词不合规'
                warnings.push(`第 ${i + 1} 行「${looks[1].trim()}」不是合法词（2-12 个中文/字母/数字/下划线，无标点空格）`)
            }
            unparsed.push({ line: i + 1, text: raw, reason, section: 'comment' })
            current = null
        }
    }

    const pending = comments.filter(c => !c.content.trim()).map(c => c.word)

    return {
        ok,
        title,
        titleRaw,
        titleLine,
        body,
        bodyLines,
        bodyStart,
        bodyEnd,
        comments,
        unparsed,
        pending,

        markerCount,
        markerLine,
        commentLines: commentRange ? lines.slice(commentRange[0], commentRange[1]) : [],
        commentRange,
        legacySourceLine,
        lineEnding,
        warnings,
        _lines: lines
    }
}
