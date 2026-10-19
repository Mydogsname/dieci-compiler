import fs from 'node:fs/promises'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * /dieci <主题> —— 建叠词文件骨架，并把「围绕主题成文」的活派给模型。
 *
 * 命令只做机械活：造文件名、写骨架、派任务。
 * 扫描与判断全交给模型自己的 find_sources / annotate —— 判据只留一份。
 *
 * recordInput: false —— 主题会写进骨架文件名，日志里不再抄一份。
 * 注意：invocation 上只有 { commandId, agent, rawInput, signal }，
 * 没有 session —— 会话必须从 invocation.agent.session 取。
 */
export function registerDieciCommand(ctx, { ext = '.txt', commandName = 'dieci' } = {}) {
    ctx.commands?.register({
        name: commandName,
        description: '输入一个主题（限30字）建叠词文件，并让 AI 成文与补注释',
        input: { hint: '<主题>' },
        recordInput: false,
        handler: (invocation) => runDieci(invocation, { ctx, ext })
    })
}

/** 会话挂在 agent 上；exec/agent 是 Cordis 代理，取属性要包 try */
function agentSession(invocation) {
    try {
        return invocation?.agent?.session ?? null
    } catch (err) {
        console.warn('[dieci] 读取 agent.session 失败：', err?.message ?? err)
        return null
    }
}

/** 工作区根：cwd → workspaceRegistry → cwd 兜底 */
async function resolveBasePath(ctx, session) {
    const cwd = session?.header?.cwd ?? null
    if (!cwd) return null

    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry?.resolveByPath) {
        try {
            const ws = await registry.resolveByPath(cwd)
            if (ws?.path) return ws.path
        } catch (err) {
            console.warn('[dieci] resolveByPath 失败：', err?.message ?? err)
        }
    }
    return cwd
}

/** 从用户输入取主题：取第一个非空行，去掉 markdown 记号，截 30 字 */
function parseTheme(rawInput) {
    const lines = String(rawInput ?? '').replace(/\r\n?/g, '\n').split('\n')
    let first = ''
    for (const line of lines) {
        const t = line.trim()
        if (t) { first = t; break }
    }
    const clean = first.replace(/^#+\s*/, '').replace(/[#*_>`]/g, '').trim()
    return clean.length > 30 ? clean.slice(0, 30) : clean
}

async function runDieci(invocation, { ctx, ext }) {
    try {
        const theme = parseTheme(invocation?.rawInput)
        if (!theme) {
            return { kind: 'error', text: '用法：/dieci <主题>　例如：/dieci 部署环境搭建' }
        }

        const session = agentSession(invocation)
        const basePath = await resolveBasePath(ctx, session)
        if (!basePath || !path.isAbsolute(basePath)) {
            return { kind: 'error', text: '建文件失败：无法解析工作区路径' }
        }

        await fs.mkdir(basePath, { recursive: true })

        // 文件名：主题 → 安全名；已存在就追加序号（不覆盖人的文件）
        const filePath = await uniquePath(basePath, toSafeName(theme), ext)
        const rel = path.relative(basePath, filePath).replace(/\\/g, '/')

        // 骨架：标题 / 空正文 / 「注释：」行。正文与注释都留给模型。
        const skeleton = oneLine(theme) + '\n\n\n注释：\n'
        const tmpPath = filePath + '.tmp'
        await fs.writeFile(tmpPath, skeleton, 'utf-8')
        await fs.rename(tmpPath, filePath)

        // 派活。文本只放"读哪些文件、干什么、不许干什么"，
        // 不放任何关系/注释内容 —— 关系属于文件，不属于消息。
        const task = [
            '【叠词：围绕主题成文】',
            `主题：${theme}`,
            `文件：${rel}（只有标题行和「注释：」，正文空）`,
            '',
            '正文只写这个主题本身，连续成段：不写「一、」，不加小标题，不用编号列表。',
            '不写"本文将…"这类元话；不许出现"材料""提示""第X节"这类对来源的指称。',
            '正文里不要出现「词：内容」式的短行。',
            '',
            '注释区写两类东西：和别处的关系，以及主题内的兑现条件。四类，都算注释：',
            '① 参数：正文里某个词的取值，来自另一份文件的产出或某一处事实 —— 写清是谁给的、给的是哪一处。',
            '② 执行结果：这份正文的产出，给哪一份文件用、当它的什么用。',
            '③ 其它关系：前两类之外的明确关系 —— 谁负责什么、谁不管什么、谁在谁之前、谁替代谁。',
            '   只写与本主题直接相关的：关系必须能落回正文里某个词，写不出对应哪个词的，不写。',
            '④ 主题内：这个词在本文里达到什么算做到、怎么验证。与别的文件无关。',
            '前三类没有就不写；第四类按正文实际情况写，没有也不凑。',
            '注释的词必须是正文里真的出现的词，不是「参数」「执行结果」「其它关系」这类关系名。',
            '只在引用独立成文的文件时写「见 文件名」（可带 :行）；自己提炼、推演、指向本文的，不写引用。',
            '注释词不用元词（推演/说明/备注/注）。',
            '',
            '先 find_sources 拿材料；材料 0 个就停下问用户，不要凭印象写。',
            '写完调 annotate 补 3–5 条注释，把被拒/待补/未识别的返回原样贴出来。',
        ].join('\n')

        try {
            invocation?.agent?.followup(
                createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })
            )
        } catch (err) {
            return {
                kind: 'error',
                text: `骨架已建好：${rel}\n但派任务给模型失败：${err?.message ?? err}`,
            }
        }

        return { kind: 'success', text: `已建 ${rel}，并已把成文任务派给模型` }
    } catch (err) {
        return { kind: 'error', text: '建文件失败：' + (err?.message ?? err) }
    }
}

// ─── 文件名小工具 ───

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** 主题 → 安全文件名：去指令词、替换非法字符、限长 100 字节 */
function toSafeName(title) {
    let name = String(title ?? '')
        .replace(/^(记一下|保存|存起来|记住|记录)[：:\s]*/, '')
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '')
        .trim()
    if (!name) name = '未命名'
    if (WIN_RESERVED.test(name)) name = `_${name}`
    if (Buffer.byteLength(name, 'utf-8') > 100) {
        name = Buffer.from(name, 'utf-8').subarray(0, 100).toString('utf-8')
        name = name.replace(/\uFFFD$/, '')
    }
    return name
}

/** 多行压成一行（标题用） */
function oneLine(s) {
    return String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
}

/** 在 baseDir 下找一个不冲突的文件路径：base.txt → base-2.txt → base-3.txt ... */
async function uniquePath(baseDir, base, ext) {
    let p = path.join(baseDir, `${base}${ext}`)
    let i = 2
    while (true) {
        try {
            await fs.access(p)
            p = path.join(baseDir, `${base}-${i}${ext}`)
            i++
        } catch {
            return p
        }
    }
}
