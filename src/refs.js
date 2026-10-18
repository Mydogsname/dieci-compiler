/**
 * 引用解析：只认「独立成文、有独立文件」的对象。
 * 自己提炼的、推演出来的、指向本文的，都不算引用 —— 不写、也不校验。
 *
 * 判定只有一种结果：能解析（文件存在、行号在范围内）或不能。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/** 指向本文的说法：不算引用。 */
export const SELF_REF = /^(本文|本篇|本节|上文|下文|同文|本文件)/

/** 显式引用：「见 文件名」，必须带 .md / .txt —— 只有独立成文的文件才算引用。
 *  前面的否定式断言挡掉「可见」「看见」「意见」这类词里的「见」。
 *  只认显式引用：正文里顺带提到文件名不算引用，工具不去猜。 */
const RE_SEE_FILE = /(?<![可看意遇罕偏见成主])见\s*[「『"“]?\s*([^\s，。；、：」』"”()（）]{1,60}\.(?:md|txt))(?::(\d+))?/g
/** 指向本文的说法：不是引用，只提示删掉。 */
const RE_SELF = /(?<![可看意遇罕偏见成主])见\s*[「『"“]?\s*(本文|本篇|本节|上文|下文|同文|本文件)/g

export function extractRefs(content) {
    const text = String(content ?? '')
    const out = []
    const seen = new Set()
    for (const m of text.matchAll(RE_SELF)) {
        const name = String(m[1] ?? '').trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push({ name, line: undefined, explicit: false, self: true })
    }
    for (const m of text.matchAll(RE_SEE_FILE)) {
        const name = String(m[1] ?? '').trim()
        if (!name) continue
        const line = m[2] === undefined ? undefined : Number(m[2])
        const key = `${name}:${line ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ name, line, explicit: true })
    }
    return out
}

export async function checkRef(basePath, name, line) {
    if (!name) return { kind: 'missing' }
    if (SELF_REF.test(name)) return { kind: 'self' }
    let p = name
    if (!path.isAbsolute(p)) p = path.join(basePath, p)
    try {
        await fs.access(p)
    } catch {
        return { kind: 'missing' }
    }
    if (line !== undefined && Number.isFinite(line)) {
        let text
        try {
            text = await fs.readFile(p, 'utf-8')
        } catch {
            return { kind: 'ok' }
        }
        const count = text.replace(/\r\n?/g, '\n').split('\n').length
        if (line < 1 || line > count) return { kind: 'range', count }
    }
    return { kind: 'ok' }
}
