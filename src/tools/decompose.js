import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePrompt } from '../parse_prompt.js'

// 不读的目录名（. 或 _ 前缀的已在 shouldSkipName 处理）
const SKIP_DIRS = new Set(['node_modules', 'packages', 'vendor', 'apps', 'boot', 'core', '.git', '.svn'])

/** 跳过自己吃自己：关系文件与已生成的提示词产物 */
const SKIP_FILE = /^(注释关系-.*|.*提示词.*)\.(md|txt)$/i

/** 原句摘录上限：整句 ≤60 字才摘，超长切不了只写文件名 */
const SENTENCE_MAX = 60

/** 每个词最多列多少份源文件的出处 */
const FILE_LIMIT = 30

/** 跳过隐藏/_前缀文件、.bak 文件 */
function shouldSkipName(name) {
    if (!name) return true
    if (name.startsWith('.') || name.startsWith('_')) return true
    if (/\.bak$/i.test(name)) return true
    return false
}

function isTextFile(name) {
    return /\.(txt|md)$/i.test(name)
}

/** 按句切分：。！？； 以及换行 */
function splitSentences(text) {
    const s = String(text ?? '').replace(/\r\n?/g, '\n')
    return s
        .split(/(?<=[。！？；\n])/u)
        .map(x => x.trim())
        .filter(Boolean)
}

/** 词在文本里的精确命中（连续子串）；词面校验与 parse_prompt 同一口径 */
function findExact(text, word) {
    const hits = []
    let idx = text.indexOf(word)
    while (idx >= 0) {
        hits.push(idx)
        idx = text.indexOf(word, idx + word.length)
        if (hits.length > 50) break
    }
    return hits
}

/** 摘一句含该词的原句；都超长则返回 null（调用方只写文件名） */
function pickSentence(sentences, word) {
    for (const s of sentences) {
        if (s.includes(word) && s.length <= SENTENCE_MAX) return s
    }
    return null
}

/** 递归扫描目录（只读）→ [{ relPath, sentences }] */
async function scanDir(dir, depth, base, out) {
    if (depth < 0) return out

    let entries
    try {
        entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
        return out
    }

    for (const ent of entries) {
        if (shouldSkipName(ent.name)) continue
        const full = path.join(dir, ent.name)

        if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue
            await scanDir(full, depth - 1, base, out)
        } else if (ent.isFile() && isTextFile(ent.name)) {
            if (SKIP_FILE.test(ent.name)) continue
            let text
            try {
                text = await fs.readFile(full, 'utf-8')
            } catch {
                continue
            }
            const parsed = parsePrompt(text)
            // 有注释区只取正文；没有就是材料原文
            const body = parsed.ok ? parsed.body : text
            out.push({ relPath: path.relative(base, full).replace(/\\/g, '/'), sentences: splitSentences(body) })
        }
    }
    return out
}

// ─── 工具工厂 ───
export function makeDecomposeTool({ ctx, fallbackWorkspace } = {}) {
    return defineTool({
        name: 'decompose',
        description: `拆解源正文，产出注释词候选表：词 | 语法角色 | 三测 | 各源文件原句。只读，不写盘。

【什么时候调用】
1. /dieci 派活后第一步
2. 用户要求「拆解 / 提炼词语 / 生成注释关系文件」

【拆解规则】
- 按中文语法切：主谓宾、偏正、动宾的中心语；词面校验 = 正文中逐字连续出现、2-12 字、无标点空格。
- 三测：指称测试（指称对象，不是语法零件）、引用测试（别的源文件会引用）、节点测试（删掉不缺节点）；过引用测试，或三测全过，才收。
- 单字（如「一」）、数词量词、值词（如「一米六五」）不收；中心语收（旧书店、素木簪、帆布鞋）。
- 原句：对每个词，在每份源文件里找包含它的句子（按 。！？； 切），整句 ≤60 字原样摘录；超长切不了只写文件名、不写原句。不删节、不归纳。

【边界】本工具只做可核对的事：找原句、数命中。语法角色与三测的判断归你 —— 词表由你（模型）先列，
本工具负责按词表回源文件取原句；给不出 words 时它只列源文件清单，不替你猜词。
【输出格式】词 | 语法角色 | 三测 | 各源文件原句（每文件一行）`,

        parameters: {
            words: {
                type: 'array',
                items: { type: 'string' },
                description: '词表。推荐显式给（先由你/用户列词，工具按词回源取原句）'
            },
            file: {
                type: 'string',
                description: '拆解的起点文件（可选；给了就只扫这一个文件，缺省扫描工作区全部文本文件）'
            },
            workspace: {
                type: 'string',
                description: '工作区目录绝对路径。缺省用会话 cwd'
            },
            depth: {
                type: 'number',
                description: '目录深度，默认 3'
            }
        },

        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }]
        },

        async execute(args, exec) {
            try {
                const { words: rawWords, file, depth = 3 } = args ?? {}

                // ── 解析工作区路径（与 find_sources / annotate 同链）──
                let cwd = null
                try {
                    cwd = exec?.agent?.session?.header?.cwd ?? null
                } catch (err) {
                    console.warn('[decompose] 读取 agent.session 失败：', err?.message ?? err)
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
                            console.warn('[decompose] 读取会话失败：', err?.message ?? err)
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
                        console.warn('[decompose] resolveByPath 失败：', err?.message ?? err)
                    }
                }
                const basePath = args.workspace ?? wsPath ?? cwd ?? fallbackWorkspace ?? process.cwd()
                if (!path.isAbsolute(basePath)) {
                    return `拆解失败：无法解析工作区路径（${basePath}）`
                }

                // ── 扫描源文件 ──
                let files = []
                if (file) {
                    let fp = file
                    if (!path.isAbsolute(fp)) fp = path.join(basePath, fp)
                    try {
                        await fs.access(fp)
                    } catch {
                        return `文件不存在：${file}`
                    }
                    const text = await fs.readFile(fp, 'utf-8')
                    const parsed = parsePrompt(text)
                    files = [{
                        relPath: path.relative(basePath, fp).replace(/\\/g, '/'),
                        sentences: splitSentences(parsed.ok ? parsed.body : text),
                    }]
                } else {
                    files = await scanDir(basePath, depth, basePath, [])
                }

                const words = (rawWords ?? []).map(w => String(w).trim()).filter(Boolean)

                // ── 没有词表：只列源文件，不替模型猜词 ──
                if (words.length === 0) {
                    const out = []
                    out.push(`扫描范围：${file ? file : basePath}（深度 ${depth}）`)
                    out.push(`源文件 ${files.length} 个（已跳过 注释关系-* 与 提示词 产物）`)
                    for (const f of files) out.push(`  · ${f.relPath}`)
                    out.push('─'.repeat(48))
                    out.push('没有给定词表。请先用 words 参数传入词表（词由你/用户先列：')
                    out.push('中文语法切出主谓宾、偏正、动宾的中心语，过 指称 / 引用 / 节点 三测），')
                    out.push('本工具再把每个词在各源文件里的原句取回来。')
                    return out.join('\n')
                }

                // ── 逐词回源取原句 ──
                const out = []
                out.push(`扫描范围：${file ? file : basePath}（深度 ${depth}）`)
                out.push(`源文件 ${files.length} 个（已跳过 注释关系-* 与 提示词 产物）`)
                out.push(`词表 ${words.length} 个`)
                out.push('─'.repeat(48))

                const noHit = []
                for (const word of words) {
                    const perFile = []
                    for (const f of files) {
                        const hits = findExact(f.sentences.join('\n'), word)
                        if (hits.length === 0) continue
                        const sentence = pickSentence(f.sentences, word)
                        perFile.push({ relPath: f.relPath, sentence, count: hits.length })
                    }

                    out.push(`词：${word}`)
                    out.push('  语法角色：（你判）｜三测：（你判：指称 / 引用 / 节点）')
                    if (perFile.length === 0) {
                        out.push('  原句：无（该词在各源文件里都没逐字出现 —— 词面校验不过，建议剔除）')
                        noHit.push(word)
                        continue
                    }
                    out.push(`  原句（${perFile.length} 份源文件命中）：`)
                    for (const p of perFile.slice(0, FILE_LIMIT)) {
                        out.push(p.sentence
                            ? `    ${p.relPath}：${p.sentence}`
                            : `    ${p.relPath}（有命中，但整句超过 ${SENTENCE_MAX} 字，切不了 —— 只写文件名）`)
                    }
                }

                if (noHit.length) {
                    out.push('─'.repeat(48))
                    out.push(`**词面校验不过（源文件里查无此词）：${noHit.join('、')}`)
                }
                out.push('？ 以上只是原句与命中事实；词收不收、三测过不过，由你判断 —— 工具不表态')

                return out.join('\n')
            } catch (err) {
                return `拆解失败：${err?.message ?? err}`
            }
        }
    })
}
