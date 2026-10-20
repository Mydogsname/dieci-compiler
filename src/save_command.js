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
            '【叠词：拆解→关系文件→组合】',
            `主题：${theme}`,
            '源文件：工作区下的全部 .txt / .md 文件（含其它叠词文件；跳过 注释关系-*.md 与已生成的提示词产物，防止自己吃自己）',
            '',
            '第一步 拆解：对每个源文件做中文语法拆解（主谓宾、偏正、动宾的中心语），过三测：',
            '  指称测试（指称对象，不是语法零件）、引用测试（别的源文件会引用它）、节点测试（删掉语义网不缺节点）；',
            '  逐词收集各源文件里的原句原文，产出词表：词 | 语法角色 | 三测 | 各源文件原句。',
            '  先贴词表给用户确认，用户点头后才进第二步。',
            '第二步 关系文件：按确认过的词表建 注释关系-<主题>.md：',
            '  词顶格；出处行缩进两空格 + 「文件名：原句」；整句 ≤60 字才摘，切不了只写文件名（不写冒号、不写原句）；',
            '  同词多处逐行、不删节、不归纳。',
            '第三步 组合：按用户需求，从关系文件挑属性重写正文（三测词必须逐字保留在正文里），',
            '  注释区写匹配：每词一条「词：见 源文件:行」；同词多处出处写进同一条，用「；见」分隔。',
            '  产出 <主题> 提示词文件（标题 + 正文 + 注释：区）。',
            '',
            '纪律：不做关系整理（不写谁给谁、谁负责、产出给谁用）；不抄来源内容进注释；不写验证。',
            '先 find_sources 核对匹配；材料 0 个就停下问用户。',
            '写完把 未识别行 / 被拒 / 待补 原样贴出来。',
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
