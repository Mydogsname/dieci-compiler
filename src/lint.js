/**
 * 只读检查：L1 分节 / L2 来源指称 / L3 注释词 / L4 覆盖率 / L5 条数。
 * 全部返回字符串警告，不修改任何东西。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { parsePrompt } from './parse_prompt.js'

/** L4 阈值：材料被正文覆盖多少算「转写」。先用 0.4，跑一遍现有文件再调。 */
export const COVERAGE_THRESHOLD = 0.4

const META_WORDS = new Set(['推演', '说明', '备注', '注', '小结', '前言', '引言', '后记'])
const FORM_WORDS = new Set(['分段', '成段', '排版', '格式', '篇幅', '标题', '正文', '结构', '版式', '字数'])

const RE_SECTION = [
    /^[一二三四五六七八九十百]+、/,
    /^\d+[.、]\s*/,
    /^#{1,6}\s/,
    /^[-*+]\s+/,
]
/** 只检查正文；注释里写「本文」是正常的，不查。 */
const RE_SOURCE = /材料|本文|本文件|两份|三份|第[一二三四五六七八九十\d]+节/

export function lintStyle(parsed) {
    const out = []
    parsed.bodyLines.forEach((line, i) => {
        const t = line.trim()
        if (!t) return
        const lineNo = parsed.bodyStart + i + 1
        for (const re of RE_SECTION) {
            if (re.test(t)) {
                out.push(`L1 正文第 ${lineNo} 行像分节/列表：「${t.slice(0, 16)}」`)
                break
            }
        }
        if (RE_SOURCE.test(t)) {
            out.push(`L2 正文第 ${lineNo} 行在指称来源：「${t.slice(0, 16)}」`)
        }
    })
    for (const c of parsed.comments) {
        if (META_WORDS.has(c.word)) out.push(`L3 注释词「${c.word}」是元词，不是主题里的概念`)
        else if (FORM_WORDS.has(c.word)) out.push(`L3 注释词「${c.word}」是文档形态词，不是主题里的概念`)
    }
    if (parsed.comments.length === 0) out.push('L5 注释 0 条')
    else if (parsed.comments.length > 5) out.push(`L5 注释 ${parsed.comments.length} 条，超过 5 条`)
    return out
}

/** 去掉空白与标点后的字符二元组 */
function bigrams(text) {
    const clean = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '')
    const set = new Set()
    for (let i = 0; i + 1 < clean.length; i++) set.add(clean.slice(i, i + 2))
    return set
}

/** 材料被正文覆盖的比例：|正文∩材料| / |材料| */
export function coverageOf(body, materialText) {
    const B = bigrams(body)
    const M = bigrams(materialText)
    if (M.size < 20) return 0
    let hit = 0
    for (const g of M) if (B.has(g)) hit++
    return hit / M.size
}

/** 扫描工作区里的材料（跳过 _ / . 目录、备份、以及本身带注释区的文件） */
export async function scanMaterials(basePath, { depth = 2 } = {}) {
    const out = []
    async function walk(dir, d) {
        if (d < 0) return
        let entries
        try {
            entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const ent of entries) {
            if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue
            if (/\.bak$/i.test(ent.name) || /\.bak-patch$/i.test(ent.name)) continue
            const full = path.join(dir, ent.name)
            if (ent.isDirectory()) {
                await walk(full, d - 1)
                continue
            }
            if (!/\.(txt|md)$/i.test(ent.name)) continue
            let text
            try {
                text = await fs.readFile(full, 'utf-8')
            } catch {
                continue
            }
            if (parsePrompt(text).ok) continue
            out.push({ relPath: path.relative(basePath, full), text })
        }
    }
    await walk(basePath, depth)
    return out
}

/** L4：只在「覆盖率高且没引用」时报一条，避免刷屏 */
export function lintCoverage(parsed, materials, refNames, selfPath) {
    const refs = new Set(refNames)
    const selfBase = selfPath ? path.basename(selfPath) : ''
    let best = null
    for (const m of materials) {
        const base = path.basename(m.relPath)
        if (base === selfBase) continue
        if (refs.has(m.relPath) || refs.has(base)) continue
        const c = coverageOf(parsed.body, m.text)
        if (!best || c > best.c) best = { c, relPath: m.relPath }
    }
    if (best && best.c >= COVERAGE_THRESHOLD) {
        return [`L4 疑似转写未引用：正文覆盖 ${best.relPath} 约 ${Math.round(best.c * 100)}%，注释里没有「见 ${best.relPath}」`]
    }
    return []
}
