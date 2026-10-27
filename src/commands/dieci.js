/**
 * /dieci —— 一条命令串三工具，不接受参数，只出注释。
 *
 * 顺序（固定，由代码串，不依赖模型自觉）：
 *   check_notes →（缺失/不合格才）decompose → check_notes 复核 →（≥2 份才）dieci
 *
 * 与 /supplement 的分工：它无题（工作区素材），/supplement 有题（剩余文本 + 题目）。
 * 两者都只产注释，成品一律交给 compose。
 *
 * 口径（全部写死，无开关）：
 *   · 工作区 = 会话 cwd（invocation.agent.session.header.cwd）
 *              缺省退 fs 服务的 config.cwd，再缺省 process.cwd()
 *   · 素材 = 工作区全部 .md/.txt（递归；跳过 语义\、叠词\、node_modules、.git 等目录）
 *   · 产物 = <工作区>\叠词\<工作区名>-注释.txt 与 <工作区>\<工作区名>-剩余.txt
 *            名字取工作区目录名（会话头只有 cwd，没有 title），不取主题：主题是 compose 的副产品
 *   · 叠词\ 在 SKIP_DIRS 里；剩余文本与提取记录靠 GENERATED 的名字规则排除
 *   · 每一步经 ctx.tools.execute 派发，与模型直接调用同一套策略、守卫与日志
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { RECORD_NAME, recordLine, appendRecord } from '../core/record.js'
import { workspaceName } from '../core/text.js'

/** 工具失败时返回的首行签名：三个工具共用「XX失败：」前缀 */
const FAIL_LINE = /^(拆解|检查|叠合)失败：/u

/** check_notes 的合格结论（它把「不合格」当正常报告，不算工具失败） */
const CHECK_PASS = /结论：通过/u

/** 算「正文」的扩展名 */
const SOURCE_EXT = /\.(md|txt|markdown|text)$/iu

/** 本插件自己的产物，不再当素材：语义、剩余文本、提取记录，以及遗留的叠词-* 工作名 */
const GENERATED = /-语义\.txt$|-剩余\.txt$|^叠词(-注释)?\.txt$|^提取记录\.txt$/iu

/** 扫描时跳过的目录：产物目录、依赖、版本库、构建输出 */
const SKIP_DIRS = new Set(['语义', '叠词', 'node_modules', '.git', '.pnpm', 'dist', 'build'])

/** 一次处理的份数上限 */
const MAX_FILES = 30

/** 注释表目录：<工作区>\叠词\ */
const OUT_DIR = '叠词'

/** 产物名后缀：前缀是工作区目录名，见 runDieci 里对 workspaceName 的调用 */
const NOTE_SUFFIX = '-注释.txt'
const RESIDUAL_SUFFIX = '-剩余.txt'

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

    // 注释表进 <工作区>\叠词\（SKIP_DIRS 里，下一轮不当素材）；剩余文本留在根目录
    // 名字前缀取工作区目录名：会话头没有工作区标题，cwd 的目录名就是它唯一的身份
    const name = workspaceName(root)
    const outDir = path.join(root, OUT_DIR)
    const notePath = path.join(outDir, `${name}${NOTE_SUFFIX}`)
    const residualPath = path.join(root, `${name}${RESIDUAL_SUFFIX}`)

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
    steps.push(`  dieci：${path.relative(root, notePath)} 与 ${path.relative(root, residualPath)} 已生成`)

    // 提取记录：dieci 是「生成」剩余文本，supplement 才是「取走」，两者分开记
    const remainCount = (await fs.readFile(residualPath, 'utf-8').catch(() => ''))
        .split('\n')
        .filter(l => l.trim())
        .length
    const recorded = await appendRecord(
        path.join(root, RECORD_NAME),
        recordLine('dieci', name, `生成 ${remainCount} 句剩余文本`),
    )
    if (recorded) steps.push(`  提取记录：${RECORD_NAME}`)

    return {
        kind: 'success',
        text: [
            `/dieci 完成（${ready.length} 份素材）`,
            '',
            ...steps,
            '',
            '只出注释：成品请另调 compose（它会扫 叠词\\ 下全部注释表）',
            '',
            dieci.text,
        ].join('\n'),
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
        description: '无题提取：串 check_notes → decompose → dieci，写 叠词\\工作区-注释.txt 与 工作区-剩余.txt；不出成品',
        handler: invocation => runDieci(ctx, invocation),
    })
}
