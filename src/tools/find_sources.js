import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePrompt } from '../parse_prompt.js'

// 不读的目录名（. 或 _ 前缀的已在 shouldSkipName 处理）
const SKIP_DIRS = new Set(['node_modules', 'packages', 'vendor', 'apps', 'boot', 'core', '.git', '.svn'])

/** 疑似匹配：窗口最多连续几行 */
const SUSPECT_MAX_WINDOW = 6
/** 疑似匹配：单行最长多少字 */
const SUSPECT_MAX_LINE = 80

/** 跳过隐藏/_前缀目录、.bak/.jsonl 文件 */
function shouldSkipName(name) {
    if (!name) return true
    if (name.startsWith('.') || name.startsWith('_')) return true
    if (/\.bak$/i.test(name)) return true
    if (/\.jsonl(\.zstd)?$/i.test(name)) return true
    return false
}

function isTextFile(name) {
    return /\.(txt|md)$/i.test(name)
}

/**
 * 判定文件类别（按内容，不按目录）—— 判据与 parse_prompt 完全一致，不再自己抄一份：
 *   有真区标记（parsed.ok） 且 文件名含「术语」 → glossary（C 类）
 *   有真区标记（parsed.ok）                    → annotated（B 类）
 *   否则（.txt / .md）                          → material（A 类）
 */
function classifyByContent(parsed, name) {
    if (!parsed.ok) return 'material'            // ok = 有真区标记（那条判据的唯一实现）
    return /术语/.test(name) ? 'glossary' : 'annotated'
}

/** 取一行不超过 max 字的预览（超长加省略号） */
function previewText(line, max = 20) {
    const s = String(line ?? '')
    return s.length > max ? s.slice(0, max) + '…' : s
}

/** 在一行里截取 word 周围的片段 */
function snippetAround(line, word, radius = 25) {
    const idx = line.indexOf(word)
    if (idx < 0) return previewText(line, 40)
    const start = Math.max(0, idx - radius)
    const end = Math.min(line.length, idx + word.length + radius)
    let s = line.slice(start, end)
    if (start > 0) s = '…' + s
    if (end < line.length) s += '…'
    return s
}

/** 归一：去掉空白 / 标点 / 符号后剩下的字母数字与汉字 */
function normalize(s) {
    return String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 单行匹配强度：
 *   精确 = 词作为连续子串
 *   归一 ≈ 去空白标点后仍为连续子串
 *   命中返回 'exact' | 'normalized'，都不中返回 null
 */
function matchStrength(line, word, normWord) {
    if (line.includes(word)) return 'exact'
    if (normWord.length >= 2 && normalize(line).includes(normWord)) return 'normalized'
    return null
}

/**
 * 疑似匹配：词的每个字都出现在「连续几行」里（词长 ≥2，每行 ≤80 字）。
 * 返回 [{ start, end }]（相对传入 lines 的 1 起行号）。
 */
function findSuspectWindows(lines, word) {
    const chars = [...new Set([...word])]
    if (chars.length < 2) return []
    const res = []
    let i = 0
    while (i < lines.length) {
        const union = new Set()
        let j = i
        let covered = false
        while (j < lines.length && (j - i) < SUSPECT_MAX_WINDOW) {
            const line = lines[j]
            if (line.length > SUSPECT_MAX_LINE) break
            if (!chars.some(c => line.includes(c))) break   // 窗口必须由"含字的连续行"组成
            for (const c of chars) if (line.includes(c)) union.add(c)
            if (chars.every(c => union.has(c))) { covered = true; break }
            j++
        }
        if (covered) {
            res.push({ start: i + 1, end: j + 1 })
            i = j + 1
        } else {
            i++
        }
    }
    return res
}

/**
 * 在一个文件的给定行集合里收集某个词的全部命中。
 * @param lines    行数组
 * @param offset   行号偏移（0 起；用于把相对行号换算成原文件行号）
 * @param word     查询词
 * @param limit    最多返回几处
 */
function collectHits(lines, offset, word, limit) {
    const normWord = normalize(word)
    const hits = []
    let found = false

    // 精确 / 归一（逐行）
    for (let i = 0; i < lines.length; i++) {
        const strength = matchStrength(lines[i], word, normWord)
        if (strength) {
            found = true
            hits.push({
                strength,
                line: offset + i + 1,
                snippet: snippetAround(lines[i], word),
            })
        }
    }

    // 疑似（窗口）：仅当本文件里"没找到"该词时才给 —— 疑似是兜底，不是补充
    if (!found) {
        const windows = findSuspectWindows(lines, word)
        for (const w of windows) {
            const firstLine = lines[w.start - 1] ?? ''
            const lastLine = lines[w.end - 1] ?? ''
            const snippet = w.start === w.end
                ? previewText(firstLine, 40)
                : `${previewText(firstLine, 24)}…${previewText(lastLine, 24)}`
            hits.push({
                strength: 'suspect',
                line: offset + w.start,
                lineEnd: offset + w.end,
                multi: w.start !== w.end,
                snippet,
            })
        }
    }

    hits.sort((a, b) => a.line - b.line)
    return hits.slice(0, limit)
}

const MARK = { exact: '=', normalized: '≈', suspect: '?' }

/** 把一处命中渲染成一行 */
function hitLine(h) {
    const loc = h.multi ? `${h.line}–${h.lineEnd}` : `${h.line}`
    const mark = MARK[h.strength] ?? '='
    const note = h.multi ? '  ← 疑似来自多行，需人工确认' : ''
    return `      ${mark} ${h.file}:${loc}   ${h.snippet}${note}`
}

/** 递归扫描目录（只读）；返回 [{ relPath, kind, text, lines, parsed }] */
async function scanDir(dir, depth, kinds, base) {
    const results = []
    if (depth < 0) return results

    let entries
    try {
        entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
        return results
    }

    for (const ent of entries) {
        if (shouldSkipName(ent.name)) continue
        const full = path.join(dir, ent.name)

        if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue
            results.push(...await scanDir(full, depth - 1, kinds, base))
        } else if (ent.isFile() && isTextFile(ent.name)) {
            try {
                const text = await fs.readFile(full, 'utf-8')
                const parsed = parsePrompt(text)
                let kind = classifyByContent(parsed, ent.name)
                // glossary 不在 kinds 里时降级为 annotated，再不在就跳过
                if (kind === 'glossary' && !kinds.includes('glossary')) kind = 'annotated'
                if (!kinds.includes(kind)) continue
                results.push({
                    relPath: path.relative(base, full),
                    kind,
                    text,
                    lines: text.replace(/\r\n?/g, '\n').split('\n'),
                    parsed: kind === 'material' ? null : parsed,
                })
            } catch {
                // 读不了就跳过
            }
        }
    }
    return results
}

/** 从注释内容里抽显式引用（见「X」/ 见 X），返回去重后的目标串 */
function extractRefs(content) {
    const refs = []
    const re = /见\s*[「『"'《]?\s*([^」』"'》\n，。、；：]{1,20})/g
    let m
    while ((m = re.exec(String(content ?? ''))) !== null) {
        const t = m[1].trim().replace(/[「『"'《」』"'》。，、；：]+$/, '')
        if (t) refs.push(t)
    }
    return [...new Set(refs)]
}

// ─── 工具工厂 ───
export function makeFindSourcesTool({ ctx, fallbackWorkspace } = {}) {
    return defineTool({
        name: 'find_sources',
        description: `找来源与已有定义。只读，不给相似度、不写盘、不建关系 —— 写注释用 annotate。

【什么时候调用】
1. 补注释前（拿候选与出处，避免重复定义）—— 调完再调 annotate
2. 用户问"这个说法有依据吗""别处定义过吗""这个词在哪出现过"
3. 你想用一个词但不确定它是否已被别的文件定义过

【不要调用】
· 想做语义判断（相似度 / 等价）—— 本工具只给可核对的线索，判断归你
· 想抽词（从正文里自动提取关键词）—— 自己读正文列词再调本工具
· 纯聊天

【它给什么】三级匹配（精确 = / 归一 ≈ / 疑似 ?）、共现、显式引用顺一跳。
所有线索都带原文位置，可回看核对。它不表态"两条线索是否指同一件事"。
【它不做什么】不判断关系成不成立、不落盘索引、不改任何文件。
【只读证据】报告末尾附 sha256 —— 证明调用前后被扫文件未变。

【让线索用得上的话】想专门看共现块与引用链，传 detail='full'。`,

        parameters: {
            words: {
                type: 'array',
                description: '要查的词。推荐显式给',
                items: { type: 'string' }
            },
            file: {
                type: 'string',
                description: '起点文件。不给 words 时，从它的注释词取'
            },
            workspace: {
                type: 'string',
                description: '工作区目录的绝对路径。缺省用当前会话 cwd'
            },
            scope: {
                type: 'array',
                description: '扫描范围（目录路径数组），默认 [会话 cwd]',
                items: { type: 'string' }
            },
            depth: {
                type: 'number',
                description: '目录深度，默认 3'
            },
            kinds: {
                type: 'array',
                description: "'material' / 'annotated' / 'glossary' 的任意组合，默认三类",
                items: { type: 'string' }
            },
            limit: {
                type: 'number',
                description: '每个词每类最多列几处，默认 3'
            },
            links: {
                type: 'boolean',
                description: '是否顺一跳解析显式引用（见「X」），默认 true'
            },
            detail: {
                type: 'string',
                description: "'brief' 或 'full'；默认 brief（full 才输出共现块与引用链）"
            }
        },

        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }]
        },

        async execute(args, exec) {
            try {
                const {
                    words: rawWords, file, scope: rawScope,
                    depth = 3,
                    kinds = ['material', 'annotated', 'glossary'],
                    limit = 3,
                    links = true,
                    detail = 'brief',
                } = args ?? {}
                const full = detail === 'full'

                // ── 解析工作区路径（与 parse_prompt / annotate 同链）──
                let cwd = null
                try {
                    cwd = exec?.agent?.session?.header?.cwd ?? null
                } catch (err) {
                    console.warn('[find_sources] 读取 agent.session 失败：', err?.message ?? err)
                }
                if (!cwd) {
                    let sessionId = null
                    try { sessionId = exec?.agent?.id ?? exec?.sessionId ?? null } catch {}
                    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
                    if (sessionId && sessions?.get) {
                        try {
                            const session = await sessions.get(sessionId)
                            cwd = session?.header?.cwd ?? session?.meta?.cwd ?? null
                        } catch (err) {
                            console.warn('[find_sources] 读取会话失败：', err?.message ?? err)
                        }
                    }
                }
                const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
                let wsPath = null
                if (cwd && registry?.resolveByPath) {
                    try {
                        const ws = await registry.resolveByPath(cwd)
                        wsPath = ws?.path ?? null
                    } catch (err) {
                        console.warn('[find_sources] resolveByPath 失败：', err?.message ?? err)
                    }
                }
                const basePath = args.workspace ?? wsPath ?? cwd ?? fallbackWorkspace ?? process.cwd()
                if (!path.isAbsolute(basePath)) {
                    return `无法解析工作区路径（${basePath}）`
                }

                // ── 解析 words ──
                let words = (rawWords ?? []).map(w => String(w).trim()).filter(Boolean)
                let sourceFileNote = ''

                // 起点文件的解析结果（供引用链"本文正文"查找复用）
                let startFileParsed = null
                let startFileRel = ''

                if (words.length === 0 && file) {
                    let filePath = file
                    if (!path.isAbsolute(filePath)) filePath = path.join(basePath, filePath)
                    try {
                        await fs.access(filePath)
                    } catch {
                        return `文件不存在，请先创建：${file}`
                    }
                    const text = await fs.readFile(filePath, 'utf-8')
                    const parsed = parsePrompt(text)
                    words = parsed.comments.map(c => c.word)
                    startFileParsed = parsed
                    startFileRel = path.relative(basePath, filePath)
                    sourceFileNote = `（从 ${startFileRel} 的 ${words.length} 个注释词取）`
                    if (words.length === 0) {
                        return `${startFileRel} 没有注释条目，无词可查。请先给 words 参数，或用 parse_prompt 看该文件状态。`
                    }
                }

                // 显式给 word 时，也尝试解析起点文件（用于引用链"本文"）
                if (!startFileParsed && file) {
                    let fp = file
                    if (!path.isAbsolute(fp)) fp = path.join(basePath, fp)
                    try {
                        const text = await fs.readFile(fp, 'utf-8')
                        startFileParsed = parsePrompt(text)
                        startFileRel = path.relative(basePath, fp)
                    } catch { /* 起点文件不存在也不影响查词 */ }
                }

                if (words.length === 0) {
                    return '没有给定要查的词。请给 words 参数（推荐），或给 file 参数从该文件的注释词取。'
                }

                // ── 解析 scope ──
                const scopeDirs = (rawScope && rawScope.length > 0 ? rawScope : [basePath]).map(d => {
                    return path.isAbsolute(d) ? d : path.join(basePath, d)
                })

                // ── 扫描 ──
                let allFiles = []
                for (const dir of scopeDirs) {
                    try {
                        await fs.access(dir)
                    } catch {
                        return `扫描范围目录不存在：${dir}`
                    }
                    allFiles.push(...await scanDir(dir, depth, kinds, basePath))
                }

                const materialCount = allFiles.filter(f => f.kind === 'material').length
                const annotatedCount = allFiles.filter(f => f.kind === 'annotated').length
                const glossaryCount = allFiles.filter(f => f.kind === 'glossary').length

                // ── 逐词匹配 ──
                const wordResults = []
                const noHitWords = []

                for (const word of words) {
                    const glossaryDefs = []  // ◆ 术语表（公约）
                    const defs = []          // ● 已有定义（B 类注释区）
                    const basis = []         // ○ 依据（A 类正文）
                    const mention = []       // ○ 谈到（B/C 类正文）

                    for (const f of allFiles) {
                        if (f.kind === 'material') {
                            basis.push(...collectHits(f.lines, 0, word, limit).map(h => ({ ...h, file: f.relPath })))
                        } else if (f.parsed) {
                            // ● / ◆ 定义：注释词 == 查询词（精确），或归一后相等
                            for (const entry of f.parsed.comments) {
                                const isExact = entry.word === word
                                const isNorm = !isExact && normalize(entry.word) === normalize(word) && normalize(word).length >= 2
                                if (isExact || isNorm) {
                                    const lineNum = (entry.lines[0] ?? 0) + 1
                                    const preview = previewText(`${entry.word}：${entry.content}`, 48)
                                    const hit = { file: f.relPath, line: lineNum, snippet: preview, strength: isExact ? 'exact' : 'normalized' }
                                    if (f.kind === 'glossary') { if (glossaryDefs.length < limit) glossaryDefs.push(hit) }
                                    else if (defs.length < limit) defs.push(hit)
                                }
                            }
                            // ○ 谈到：正文里命中（含疑似）
                            const body = f.parsed.bodyLines
                            const off = f.parsed.bodyStart
                            mention.push(...collectHits(body, off, word, limit).map(h => ({ ...h, file: f.relPath })))
                        }
                    }

                    const anyHit = glossaryDefs.length || defs.length || basis.length || mention.length
                    if (!anyHit) noHitWords.push(word)
                    wordResults.push({ word, glossaryDefs, defs, basis, mention })
                }

                // ── 共现（同一文件里 ≥2 个查询词出现）──
                const cooccur = []
                if (full && words.length >= 2) {
                    for (const f of allFiles) {
                        const perWord = []
                        for (const word of words) {
                            let n = 0
                            if (f.kind === 'material') {
                                n = collectHits(f.lines, 0, word, 999).length
                            } else if (f.parsed) {
                                n = collectHits(f.parsed.bodyLines, f.parsed.bodyStart, word, 999).length
                                if (f.parsed.comments.some(e => e.word === word)) n += 1
                            }
                            if (n > 0) perWord.push(`「${word}」${n} 次`)
                        }
                        if (perWord.length >= 2) {
                            cooccur.push(`  · ${f.relPath}   同时命中 ${perWord.join(' / ')}`)
                        }
                    }
                }

                // ── 引用链（顺一跳，深度 1）──
                const linkLines = []
                if (links && full && startFileParsed) {
                    const body = startFileParsed.bodyLines
                    const commentLines = startFileParsed.commentLines ?? []
                    for (const entry of startFileParsed.comments) {
                        const refs = extractRefs(entry.content)
                        for (const ref of refs) {
                            const targets = []
                            // 先在本文件正文里找
                            for (let i = 0; i < body.length; i++) {
                                if (body[i].includes(ref)) targets.push(startFileParsed.bodyStart + i + 1)
                            }
                            // 再在其它文件里找（仍深度 1，不再顺下去）
                            if (targets.length === 0) {
                                for (const f of allFiles) {
                                    if (f.relPath === startFileRel) continue
                                    for (let i = 0; i < f.lines.length; i++) {
                                        if (f.lines[i].includes(ref)) { targets.push(`其他文件 ${f.relPath}:${i + 1}`); break }
                                    }
                                }
                            }
                            const entryLine = (entry.lines[0] ?? 0) + 1
                            const contentPreview = previewText(entry.content, 30)
                            const targetDesc = targets.length
                                ? `指向 ${typeof targets[0] === 'string' ? targets[0] : `本文正文第 ${targets.join('、')} 行`}`
                                : '→ 未找到'
                            linkLines.push(`  · ${startFileRel}:${entryLine}  注释「${entry.word}：${contentPreview}」→ ${targetDesc}`)
                        }
                    }
                }

                // ── 生成报告 ──
                const out = []
                out.push(`扫描范围：${scopeDirs.join('、')}（深度 ${depth}）`)
                out.push(`来源：材料 ${materialCount} 个 · 带注释的文件 ${annotatedCount} 个 · 术语表 ${glossaryCount} 个${sourceFileNote}`)
                out.push('─'.repeat(48))

                for (const { word, glossaryDefs, defs, basis, mention } of wordResults) {
                    out.push(`词「${word}」`)
                    // ◆ 术语表
                    if (glossaryDefs.length) {
                        out.push(`  ◆ 术语表（词该怎么理解）`)
                        for (const h of glossaryDefs) out.push(hitLine(h))
                    }
                    // ● 已有定义
                    if (defs.length) {
                        out.push(`  ● 已有定义（别处的注释里）—— 宜引用，别重定义`)
                        for (const h of defs) out.push(hitLine(h))
                    } else {
                        out.push(`  ● 已有定义：无`)
                    }
                    // ○ 依据
                    if (basis.length) {
                        out.push(`  ○ 依据（材料的正文里）`)
                        for (const h of basis) out.push(hitLine(h))
                    } else {
                        out.push(`  ○ 依据：无`)
                    }
                    // ○ 谈到
                    if (mention.length) {
                        out.push(`  ○ 谈到（叠词文件的正文里）`)
                        for (const h of mention) out.push(hitLine(h))
                    } else {
                        out.push(`  ○ 谈到：无`)
                    }
                }

                // ── 共现 / 引用链（仅 full）──
                if (full && (cooccur.length || linkLines.length)) {
                    out.push('─'.repeat(48))
                    if (cooccur.length) {
                        out.push(`共现线索（同一文件里多个查询词都出现）`)
                        out.push(...cooccur)
                    }
                    if (linkLines.length) {
                        out.push(`引用链（顺一跳）`)
                        out.push(...linkLines)
                    }
                }

                // ── 找不到依据的词 ──
                if (noHitWords.length) {
                    out.push('─'.repeat(48))
                    out.push(`**在材料与既有注释里都找不到依据的词：${noHitWords.join('、')}`)
                    out.push('（这些只能自指，请在注释里写明依据来自本文哪一节）')
                }

                out.push('？ 以上线索是否指同一件事，由模型判断；工具只报事实，不表态')
                out.push(`文件：${scopeDirs.join('、')}`)
                const io = crypto.createHash('sha256')
                for (const f of [...allFiles].sort((a, b) => a.relPath < b.relPath ? -1 : 1)) {
                    io.update(f.relPath).update('\n').update(f.text).update('\n')
                }
                out.push(`sha256：${io.digest('hex').slice(0, 12)}（只读，未写盘）`)

                return out.join('\n')
            } catch (err) {
                return `查找失败：${err?.message ?? err}`
            }
        }
    })
}
