import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePrompt, serialize, RE_WORD } from '../parse_prompt.js'

const VALID_MODES = ['fill', 'append', 'fill+append']

/** 把 content 拆成首行 + 续行。
 *  P3-⑨：续行 strip 每行前导空白再统一加 2 空格，避免调用方自带缩进写出 4 空格。 */
function splitContentLines(content) {
    const ls = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
    return {
        first: ls[0] ?? '',
        rest: ls.slice(1).map(l => l.replace(/^\s+/, ''))
    }
}

/** 取一行不超过 max 字的预览（超长加省略号） */
function previewText(line, max = 20) {
    const s = String(line ?? '')
    return s.length > max ? s.slice(0, max) + '…' : s
}

/** 取第一个区标记之前的全部内容（用于写后比对标题+正文） */
function cutPreamble(text) {
    const ls = text.split(/\r\n|\r|\n/)
    for (let i = 0; i < ls.length; i++) {
        const t = ls[i].trim()
        if (t === '注释：' || t === '出处：') return ls.slice(0, i).join('\n')
    }
    return text
}

/** 段内最后一个非空行的索引；段全空则返回段起点 - 1（即标记行） */
function lastNonBlank(lines, range) {
    for (let i = range[1] - 1; i >= range[0]; i--) {
        if (lines[i].trim() !== '') return i
    }
    return range[0] - 1
}

// ─── 工具工厂 ───
export function makeAnnotateTool({ ctx, fallbackWorkspace } = {}) {
    return defineTool({
        name: 'annotate',
        description: `补全一个叠词文件里的注释区。只写。要看状态，用 parse_prompt。

【什么时候调用】命中任意一条就调用，不要等用户明说：
T1 用户明确要求：补注释 / 补齐注释 / 整理成文件 / 落成任务
T2 你读到某个文件，它满足【叠词文件特征】= 有独占一行的「注释：」，
   并且存在缺口（有空条目 / 读过正文后发现该写关系的却没有条目 / 正文里的词和注释对不上）
   → 直接调用（本工具无损：不覆盖已有内容、不删任何行、引用解析不了直接拒，可以主动）
T3 用户给了要求、想落成文件 → 先让用户建文件（本工具不建文件），再补

【不要调用】
· 文件没有独占一行的「注释：」 → 先告诉用户加这一行，不要硬调
· 文件不存在 → 告诉用户先建
· 注释区已齐、你又写不出新关系或新兑现条件 → 宁可不调
· 纯聊天、没有落成文件的意图

【引用】只在引用独立成文的文件时写「见 文件名」（可带 :行）。自己提炼、推演、指向本文的，不写引用。
【调用后】把返回原样贴给用户，尤其这三类别吞掉：未识别行 / 被拒 / 仍是空的（待补）。
同一条内容不要重复调用 —— 第二次只会报"无变化"。

补全规则：
- 注释是匹配：正文里出现的词 + 它在别处的出处，写成「词：见 文件:行」；同一词多处出处写进同一条，用「；见」分隔。
- 只写精确匹配；近似、疑似不写。匹配不到出处就不写，宁缺勿凑。
- 不写关系整理（谁给的、谁负责、谁替代谁、产出给谁用）、不抄来源内容、不写处理指示（按原事实/不夸张/只转写/不另立构图）、不写验证。
- 词必须是正文里真的出现的词，不是「参数」「执行结果」「其它关系」这类关系名。
- 不要废话，注释语义要唯一。
- 不要改动标题和正文 —— 那是用户的原话。
- 不要重排或删除已有条目 —— 那是用户的或上一轮的成果。`,

        parameters: {
            file: {
                type: 'string',
                required: true,
                description: '工作区相对路径（如 "生成人物肖像.md"、"人物描写.md"）或绝对路径'
            },
            workspace: {
                type: 'string',
                description: '工作区目录的绝对路径。缺省用当前会话 cwd'
            },
            comments: {
                type: 'array',
                required: true,
                description: 'AI 判断的产物，每条含 word / content / basis',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        word:    { type: 'string', required: true, description: '词。2-12 字，不含冒号' },
                        content: { type: 'string', description: '内容，可为空字符串（= 待补）' },
                        basis:   { type: 'string', description: '可选。引用哪个文件作依据，写「文件:行」；自指或自己提炼的不填' }
                    }
                }
            },
            mode: {
                type: 'string',
                description: "'fill' | 'append' | 'fill+append'（默认 fill+append）"
            }
        },

        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }]
        },

        async execute(args, exec) {
            try {
                const { file, comments = [], mode = 'fill+append' } = args ?? {}

                // ── 0. mode 校验：非法值直接失败，不碰文件 ──
                if (!VALID_MODES.includes(mode)) {
                    return `补全失败：mode 取值非法（${mode}），允许的值：fill / append / fill+append`
                }
                const doFill   = mode === 'fill' || mode === 'fill+append'
                const doAppend = mode === 'append' || mode === 'fill+append'

                // ── 1. 解析工作区路径（与 memory_save.js 同链）──
                let cwd = null
                try {
                    cwd = exec?.agent?.session?.header?.cwd ?? null
                } catch (err) {
                    console.warn('[annotate] 读取 agent.session 失败：', err?.message ?? err)
                }

                if (!cwd) {
                    let sessionId = null
                    try {
                        sessionId = exec?.agent?.id ?? exec?.sessionId ?? null
                    } catch {}
                    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
                    if (sessionId && sessions?.get) {
                        try {
                            const session = await sessions.get(sessionId)
                            cwd = session?.header?.cwd ?? session?.meta?.cwd ?? null
                        } catch (err) {
                            console.warn('[annotate] 读取会话失败：', err?.message ?? err)
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
                        console.warn('[annotate] resolveByPath 失败：', err?.message ?? err)
                    }
                }

                const basePath = args.workspace ?? wsPath ?? cwd ?? fallbackWorkspace ?? process.cwd()
                if (!path.isAbsolute(basePath)) {
                    return `补全失败：无法解析工作区路径（${basePath}）`
                }

                // ── 2. 定位文件；不存在 → 报错，不创建 ──
                let filePath = file
                if (!path.isAbsolute(filePath)) {
                    filePath = path.join(basePath, filePath)
                }
                try {
                    await fs.access(filePath)
                } catch {
                    return `文件不存在，请先创建：${file}`
                }

                // ── 3. 读取 + 解析 ──
                const raw = await fs.readFile(filePath, 'utf-8')
                const parsed = parsePrompt(raw)
                const entryMap = new Map(parsed.comments.map(c => [c.word, c]))

                // ── 4. 逐条分类 ──
                const written   = []   // 真正写入了非空内容的词（报告"补全"）
                const pendingNew = []  // 新追加的空待补词
                const skipModeAdd = [] // mode 不允许追加
                const skipModeFill = [] // mode 不允许补全
                const skipDup = []     // 同一批里重复提交
                const skipSame = []    // 提交内容 = 已有内容（已一致，不算跳过）
                const skipExist = []   // 已有内容且不同（真跳过）
                const blocked = []     // 文件无注释区，想补也补不进去
                const rejected = []    // { word, reason }
                const seen = new Set()

                // 行级编辑操作：{ at, kind, lines, seq }，应用时按 (at↓, seq↓) 排序
                const ops = []
                let seq = 0
                const commentAppends = [] // 注释区末尾追加的行（合并为一个 insert）

                for (const comment of comments) {
                    const word    = String(comment?.word ?? '').trim()
                    const content = String(comment?.content ?? '')

                    // 4a. 校验（优先于查重）
                    if (!word || !RE_WORD.test(word)) {
                        rejected.push({
                            word: word || '(空)',
                            reason: '词不合规（2-12 个中文/字母/数字/下划线，无标点空格）'
                        })
                        continue
                    }

                    // 4b. 同批重复
                    if (seen.has(word)) {
                        skipDup.push(word)
                        continue
                    }
                    seen.add(word)

                    const existing = entryMap.get(word)
                    const hasText  = content.trim() !== ''

                    if (existing) {
                        if (existing.content.trim()) {
                            // 已有非空内容：区分"完全相同"和"不同"
                            const { first, rest } = splitContentLines(content)
                            const rebuilt = rest.length > 0
                                ? first + '\n' + rest.join('\n')
                                : first
                            const oldNorm = existing.content.replace(/\s+/g, ' ').trim()
                            const newNorm = rebuilt.replace(/\s+/g, ' ').trim()
                            if (oldNorm === newNorm) {
                                skipSame.push(word)
                            } else {
                                skipExist.push(word)
                            }
                        } else if (!hasText) {
                            // 空补空：什么都不算，仍在待补清单；不写出处
                            continue
                        } else if (doFill) {
                            // 点名补全：替换首行 + 插入续行
                            const { first, rest } = splitContentLines(content)
                            const headAt = existing.lines[0]
                            ops.push({ at: headAt, kind: 'replace', lines: [`${word}：${first}`], seq: seq++ })
                            if (rest.length > 0) {
                                ops.push({
                                    at: headAt + 1, kind: 'insert',
                                    lines: rest.map(r => `  ${r}`), seq: seq++
                                })
                            }
                            written.push(word)
                        } else {
                            skipModeFill.push(word)
                        }
                    } else {
                        // 新词
                        if (!doAppend) {
                            skipModeAdd.push(word)
                            continue
                        }
                        if (!parsed.ok) {
                            // 没有注释区：分类照做、被拒照报，但不产生任何写入
                            blocked.push(word)
                            continue
                        }
                        const { first, rest } = splitContentLines(content)
                        commentAppends.push(`${word}：${first}`)
                        for (const r of rest) commentAppends.push(`  ${r}`)
                        if (hasText) {
                            written.push(word)
                        } else {
                            pendingNew.push(word)
                        }
                    }
                }

                // ── 5. 没有「注释：」区 → 不写入（先完成分类，被拒清单仍可报告）──
                if (!parsed.ok) {
                    const ls = []
                    ls.push('未写入：文件缺少「注释：」区标记，请先在正文后添加一行「注释：」')
                    if (blocked.length) ls.push(`未能补全 ${blocked.length} 条：${blocked.join(' / ')}`)
                    for (const w of parsed.warnings) ls.push(`警告：${w}`)
                    appendRejected(ls, rejected)
                    ls.push(`文件：${filePath}`)
                    return ls.join('\n')
                }

                // ── 6. 生成行级 ops ──
                if (commentAppends.length > 0) {
                    const at = lastNonBlank(parsed._lines, parsed.commentRange) + 1
                    ops.push({ at, kind: 'insert', lines: commentAppends, seq: seq++ })
                }


                // ── 7. 从后往前应用（大索引先动，小索引不失效；同 at 时 seq 大的先动）──
                const nextLines = [...parsed._lines]
                ops.sort((a, b) => b.at - a.at || b.seq - a.seq)
                for (const op of ops) {
                    if (op.kind === 'replace') {
                        nextLines[op.at] = op.lines[0]
                    } else {
                        nextLines.splice(op.at, 0, ...op.lines)
                    }
                }
                const newRaw = serialize(nextLines, parsed.lineEnding)

                // ── 8. 落盘：tmp → rename（原子写，不写备份）──
                let changed = false
                let after = raw
                if (newRaw !== raw) {
                    const tmpPath = `${filePath}.tmp`
                    await fs.writeFile(tmpPath, newRaw, 'utf-8')
                    await fs.rename(tmpPath, filePath)
                    changed = true
                    after = newRaw
                }

                // ── 9. 写后读回，比对标题+正文（P0-2：不硬编码"未改动"）──
                let samePreamble = true
                if (changed) {
                    const reread = await fs.readFile(filePath, 'utf-8')
                    after = reread
                    samePreamble = cutPreamble(raw) === cutPreamble(reread)
                }

                // ── 10. 报告（全部是比对出来的结果）──
                const stillEmpty = [
                    ...parsed.pending.filter(w => !written.includes(w)),
                    ...pendingNew
                ]
                const unparsedLines = parsed.unparsed.map(u => u.line)
                const hash = crypto.createHash('sha256').update(after).digest('hex').slice(0, 12)

                const out = []
                if (!changed) {
                    out.push('无变化')
                } else if (written.length > 0) {
                    out.push(`补全 ${written.length} 条：${written.join(' / ')}`)
                } else {
                    out.push('无新增')
                }
                if (pendingNew.length > 0) {
                    out.push(`新增 ${pendingNew.length} 个待补项（空内容）：${pendingNew.join(' / ')}`)
                }

                if (skipSame.length)   out.push(`已一致 ${skipSame.length} 条（提交内容 = 已有内容）：${skipSame.join(' / ')}`)
                if (skipExist.length)  out.push(`跳过 ${skipExist.length} 条（已有内容且不同，未覆盖）：${skipExist.join(' / ')}`)
                if (skipModeAdd.length) out.push(`跳过 ${skipModeAdd.length} 条（mode 不允许追加）：${skipModeAdd.join(' / ')}`)
                if (skipModeFill.length) out.push(`跳过 ${skipModeFill.length} 条（mode 不允许补全）：${skipModeFill.join(' / ')}`)
                if (skipDup.length)     out.push(`跳过 ${skipDup.length} 条（同一批里重复提交）：${skipDup.join(' / ')}`)
                appendRejected(out, rejected)

                if (unparsedLines.length) {
                    // 用 20 字预览（与 parse_prompt 工具同款）
                    const byLine = new Map(parsed.unparsed.map(u => [u.line, u]))
                    const items = unparsedLines
                        .map(n => `第 ${n} 行「${previewText(byLine.get(n)?.text, 20)}」`)
                        .join('、')
                    out.push(`未识别行：${unparsedLines.length} 行（已原样保留，${items}）`)
                } else {
                    out.push('未识别行：0 行')
                }
                if (stillEmpty.length) {
                    out.push(`仍是空的（待补）：${stillEmpty.join(' / ')}`)
                } else {
                    out.push('仍是空的（待补）：无')
                }
                if (parsed.warnings.length > 0) {
                    out.push(`警告：${parsed.warnings.length} 条`)
                    for (const w of parsed.warnings) out.push(`  · ${w}`)
                } else {
                    out.push('警告：无')
                }

                out.push(samePreamble
                    ? '未改动：标题、正文'
                    : '❗ 注意：标题或正文发生了变化（这是 bug，请报告）')
                out.push(`文件：${filePath}`)
                out.push(`sha256：${hash}`)

                return out.join('\n')
            } catch (err) {
                return `补全失败：${err?.message ?? err}`
            }
        }
    })
}

/** 被拒清单：逐条带原因 */
function appendRejected(out, rejected) {
    if (!rejected.length) return
    const items = rejected.map(r => `${r.word}（${r.reason}）`).join(' / ')
    out.push(`被拒 ${rejected.length} 条：${items}`)
}


