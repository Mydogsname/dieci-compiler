/**
 * /dieci —— 一条命令串三工具，不接受参数。
 *
 * 顺序（固定，由代码串，不依赖模型自觉）：
 *   check_notes →（缺失/不合格才）decompose → check_notes 复核 →（≥2 份才）dieci → compose
 *
 * 口径（全部写死，无开关）：
 *   · 工作区 = 会话 cwd（invocation.agent.session.header.cwd）
 *              缺省退 fs 服务的 config.cwd，再缺省 process.cwd()
 *   · 素材 = 工作区全部 .md/.txt（递归；跳过 语义\、叠词\、node_modules、.git 等目录）
 *   · 产物 = <工作区>\叠词\<标题>-注释.txt 与 <工作区>\叠词\<标题>.txt（成品）
 *            <工作区>\<标题>-残句.txt 留在根目录
 *            标题取自 compose 产出的「主题：」行；中途先写工作名 叠词-*.txt，再改名
 *   · 叠词\ 在 SKIP_DIRS 里，注释与成品下一轮不会被当素材；残句靠 GENERATED 的 -残句.txt 规则排除
 *   · 每一步经 ctx.tools.execute 派发，与模型直接调用同一套策略、守卫与日志
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { themeOf } from '../tools/compose.js'

/** 工具失败时返回的首行签名：三个工具共用「XX失败：」前缀 */
const FAIL_LINE = /^(拆解|检查|叠合)失败：/u

/** check_notes 的合格结论（它把「不合格」当正常报告，不算工具失败） */
const CHECK_PASS = /结论：通过/u

/** 算「正文」的扩展名 */
const SOURCE_EXT = /\.(md|txt|markdown|text)$/iu

/** 本插件自己的产物，不再当素材（叠词-* 是遗留的工作名；残句留在根目录，靠后缀排除） */
const GENERATED = /-语义\.txt$|-残句\.txt$|^叠词(-注释)?\.txt$/iu

/** 扫描时跳过的目录：产物目录、依赖、版本库、构建输出 */
const SKIP_DIRS = new Set(['语义', '叠词', 'node_modules', '.git', '.pnpm', 'dist', 'build'])

/** 一次处理的份数上限 */
const MAX_FILES = 30

/** 产物目录：注释与成品落在 <工作区>\叠词\ 下 */
const OUT_DIR = '叠词'

/** 工作名：先写这三个，拿到主题后再改成 <标题>-… */
const WORK_NOTE = '叠词-注释.txt'
const WORK_RESIDUAL = '叠词-残句.txt'
const WORK_PRODUCT = '叠词.txt'

/** 模型没给主题行时的兜底标题 */
const FALLBACK_TITLE = '叠词'

/** 文件名里不能出现的字符 */
const ILLEGAL_IN_NAME = /[\\/:*?"<>|\u0000-\u001f]/gu

/** 标题过长时截断，给 -注释 / -残句 后缀留位置 */
const TITLE_MAX = 60

const USAGE = '用法：/dieci（不接受参数）'

/**
 * 工作区根目录。
 *
 * 三级来源，取第一个可用的：
 *   1. 会话创建时的 cwd —— 这才是「用户的会话工作区」，也是沙箱边界
 *   2. fs 服务的 config.cwd —— 全局解析默认值，通常是进程启动目录
 *   3. process.cwd()
 *
 * @param {object} ctx 带 fs 服务的上下文
 * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
 * @returns {string} 绝对路径
 */
function workspaceRoot(ctx, invocation) {
    const headerCwd = invocation?.agent?.session?.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd) return headerCwd

    const fsService = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
    const fxCwd = fsService?.config?.cwd
    if (typeof fxCwd === 'string' && fxCwd) return fxCwd

    return process.cwd()
}

/**
 * 递归收集根目录下的正文文件。
 * @param {string} root 绝对路径
 * @returns {Promise<string[]>} 绝对路径，按名字排序
 */
async function collectSources(root) {
    const found = []
    async function walk(dir) {
        let entries
        try {
            entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.')) continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) await walk(full)
                continue
            }
            if (!entry.isFile()) continue
            if (!SOURCE_EXT.test(entry.name)) continue
            if (GENERATED.test(entry.name)) continue
            found.push(full)
        }
    }
    await walk(root)
    return found
}

/**
 * 派发一次工具调用，把「工具层面的失败」与「业务层面的结论」分开。
 * @returns {Promise<{ ok: boolean, text: string }>} ok=false 表示该步失败
 */
async function runTool(ctx, invocation, name, args, seq) {
    let res
    try {
        res = await ctx.tools.execute({
            callId: CallId(`dieci:${seq}:${name}`),
            name,
            arguments: args,
            agent: invocation.agent,
            signal: invocation.signal,
        })
    } catch (err) {
        return { ok: false, text: `${name} 调度失败：${err?.message ?? err}` }
    }

    if (res?.isError) {
        return { ok: false, text: `${name} 执行失败：${res.error?.message ?? '未知错误'}` }
    }
    const text = typeof res?.value === 'string' ? res.value : String(res?.value ?? '')
    return { ok: !FAIL_LINE.test(text), text }
}

/** Windows 路径比较不分大小写；别处按小写比也不会错 */
function samePath(a, b) {
    const norm = p => path.resolve(p).replace(/[\\/]+$/u, '').toLowerCase()
    return norm(a) === norm(b)
}

/** 主题 → 合法文件名：去非法字符、压空白、收尾去点去空格；清空则返回空串交给兜底 */
function titleFromTheme(theme) {
    const cleaned = String(theme ?? '')
        .replace(/[\r\n\t]+/gu, ' ')
        .replace(ILLEGAL_IN_NAME, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/^[. ]+|[. ]+$/gu, '')
    if (!cleaned) return ''
    return (cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX) : cleaned).trim()
}

/** 改名；同名直接跳过（标题兜底成「叠词」时就是原地不动） */
async function renameTo(from, to) {
    if (samePath(from, to)) return
    await fs.rename(from, to)
}

/**
 * 串连执行。
 * @param {object} ctx 带 tools 服务的上下文
 * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
 * @returns {Promise<{ kind: 'success'|'error', text: string }>}
 */
export async function runDieci(ctx, invocation) {
    if (invocation.rawInput.trim().length > 0) {
        return { kind: 'error', text: USAGE }
    }

    const root = workspaceRoot(ctx, invocation)
    const stat = await fs.stat(root).catch(() => null)
    if (!stat?.isDirectory()) return { kind: 'error', text: `工作区目录不存在：${root}` }

    const targets = await collectSources(root)
    if (!targets.length) return { kind: 'error', text: `工作区里没有可处理的 .md / .txt：${root}` }
    if (targets.length > MAX_FILES) {
        return {
            kind: 'error',
            text: [
                `扫到 ${targets.length} 份正文，超过上限 ${MAX_FILES}。`,
                '/dieci 不接参数，请先移走无关文件，或用工具逐个处理。',
                `扫描根目录：${root}`,
            ].join('\n'),
        }
    }

    const steps = [`扫描根目录：${root}（${targets.length} 份）`]
    const ready = []
    let seq = 0

    // ── 第一段：逐个素材自检，缺/不合格才重拆并复核 ──
    for (const file of targets) {
        const name = path.basename(file)

        const check = await runTool(ctx, invocation, 'check_notes', { file }, ++seq)
        if (check.ok && CHECK_PASS.test(check.text)) {
            steps.push(`· ${name}：语义文件已通过自检，跳过 decompose`)
            ready.push(file)
            continue
        }

        steps.push(`· ${name}：语义文件缺失或未通过自检 → decompose`)

        const dec = await runTool(ctx, invocation, 'decompose', { file }, ++seq)
        if (!dec.ok) {
            return {
                kind: 'error',
                text: [`/dieci 中止：${name} 拆解失败`, '', dec.text, '', '前序步骤：', ...steps].join('\n'),
            }
        }
        steps.push(`  ${dec.text.split('\n')[0]}`)

        const recheck = await runTool(ctx, invocation, 'check_notes', { file }, ++seq)
        if (!recheck.ok || !CHECK_PASS.test(recheck.text)) {
            return {
                kind: 'error',
                text: [`/dieci 中止：${name} 拆解后复核未通过`, '', recheck.text, '', '前序步骤：', ...steps].join('\n'),
            }
        }
        steps.push('  复核：通过')
        ready.push(file)
    }

    // ── 第二段：叠合 ──
    if (ready.length < 2) {
        return {
            kind: 'success',
            text: [
                `/dieci 完成（${ready.length} 份素材）`,
                '',
                ...steps,
                '',
                '少于 2 份素材，跳过 dieci —— 叠合至少需要 2 份。',
            ].join('\n'),
        }
    }

    // 注释与成品落进 <工作区>\叠词\（SKIP_DIRS 里，下一轮不当素材）；残句留在根目录
    const outDir = path.join(root, OUT_DIR)
    const notePath = path.join(outDir, WORK_NOTE)
    const residualPath = path.join(root, WORK_RESIDUAL)
    const productPath = path.join(outDir, WORK_PRODUCT)

    const dieci = await runTool(ctx, invocation, 'dieci', {
        materials: ready,
        out: notePath,
        outResidual: residualPath,
    }, ++seq)

    if (!dieci.ok) {
        return {
            kind: 'error',
            text: ['/dieci 中止：叠合失败', '', dieci.text, '', '前序步骤：', ...steps].join('\n'),
        }
    }
    steps.push('  dieci：注释与残句已生成')

    const compose = await runTool(ctx, invocation, 'compose', {
        note: notePath,
        residual: residualPath,
        out: productPath,
    }, ++seq)

    if (!compose.ok) {
        return {
            kind: 'error',
            text: ['/dieci 中止：成品生成失败', '', compose.text, '', '前序步骤：', ...steps].join('\n'),
        }
    }

    // ── 第三段：按主题给产物改名 ──
    const productRaw = await fs.readFile(productPath, 'utf-8').catch(() => '')
    const title = titleFromTheme(themeOf(productRaw)) || FALLBACK_TITLE

    const inDir = path.join(outDir, title)
    const finalProduct = `${inDir}.txt`
    const finalNote = `${inDir}-注释.txt`
    const finalResidual = path.join(root, `${title}-残句.txt`)

    try {
        // 先注释、后成品：万一标题正好叫「叠词-注释」，成品才落得到那个位置
        await renameTo(notePath, finalNote)
        await renameTo(residualPath, finalResidual)
        await renameTo(productPath, finalProduct)
    } catch (err) {
        return {
            kind: 'error',
            text: [
                `/dieci 中止：产物改名失败（标题「${title}」）`,
                '',
                String(err?.message ?? err),
                '',
                `工作名文件仍在：${notePath} / ${residualPath} / ${productPath}`,
                '',
                '前序步骤：', ...steps,
            ].join('\n'),
        }
    }

    const paths = [finalProduct, finalNote, finalResidual]
    steps.push(`  compose：主题「${title}」`)
    steps.push(`  产物：${paths.map(p => path.relative(root, p)).join(' / ')}`)

    // compose 面板里那句已落盘还指着工作名，换成最终路径
    const composeText = compose.text.replace(/^已落盘：.*$/mu, () => `已落盘：${finalProduct}`)

    return {
        kind: 'success',
        text: [`/dieci 完成（${ready.length} 份素材）`, '', ...steps, '', composeText].join('\n'),
    }
}

/**
 * 注册 /dieci。
 * @param {object} ctx 带 commands 与 tools 服务的上下文
 * @returns {unknown} 注册句柄
 */
export function registerDieciCommand(ctx) {
    return ctx.commands.register({
        name: 'dieci',
        description: '串连 check_notes → decompose → dieci → compose，处理工作区全部并按主题写 <标题>、<标题>-注释、<标题>-残句',
        handler: invocation => runDieci(ctx, invocation),
    })
}
