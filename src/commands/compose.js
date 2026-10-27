/**
 * /compose —— 叠注释表 → 成品，不接受参数。
 *
 * 与两条提取命令的分工：
 *   /dieci       无参数：工作区素材 → 叠词\工作区-注释.txt + 工作区-剩余.txt
 *   /supplement  要题目：剩余文本 → 叠词\<题目>-注释.txt
 *   /compose     无参数：叠词\ 下全部 *-注释.txt + 工作区-剩余.txt → 叠词\成品.txt
 *
 * 口径（全部写死，无开关）：
 *   · 注释表 = 叠词\ 下全部，先 <工作区名>-注释.txt（管内容）、后其余 <题目>-注释.txt（补规格与约束），同一后缀靠题目区分
 *   · 剩余文本 = 工作区根目录的工作区-剩余.txt
 *   · 成品 = 叠词\<工作区名>.txt：名字取工作区目录名，成品只有一份，重跑覆盖
 *   · 不接受参数：要指定层次或别的落点，请手调 compose 工具
 *   · 每一步经 ctx.tools.execute 派发，与模型直接调用同一套策略、守卫与日志
 */

import path from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import { workspaceName } from '../core/text.js'

/** 工具失败时返回的首行签名 */
const FAIL_LINE = /^成稿失败：/u

/** 成品目录 */
const OUT_DIR = '叠词'

const USAGE = '用法：/compose（不接受参数）'

/**
 * 工作区根目录：会话 cwd → fs 服务 config.cwd → process.cwd()
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
 * 派发一次工具调用，把「工具层面的失败」与「业务层面的结论」分开。
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function runTool(ctx, invocation, name, args) {
    let res
    try {
        res = await ctx.tools.execute({
            callId: CallId(`compose-cmd:${name}`),
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
 * 执行一次成稿。
 * @param {object} ctx 带 tools 服务的上下文
 * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
 * @returns {Promise<{ kind: 'success'|'error', text: string }>}
 */
export async function runCompose(ctx, invocation) {
    if (String(invocation?.rawInput ?? '').trim().length > 0) {
        return { kind: 'error', text: USAGE }
    }

    const root = workspaceRoot(ctx, invocation)
    const out = path.join(root, OUT_DIR, `${workspaceName(root)}.txt`)

    const res = await runTool(ctx, invocation, 'compose', { out })
    if (!res.ok) {
        return {
            kind: 'error',
            text: [`/compose 失败`, '', res.text].join('\n'),
        }
    }

    return {
        kind: 'success',
        text: [`/compose 完成`, `工作区：${root}`, `成品：${out}`, '', res.text].join('\n'),
    }
}

/**
 * 注册 /compose。
 * @param {object} ctx 带 commands 与 tools 服务的上下文
 * @returns {unknown} 注册句柄
 */
export function registerComposeCommand(ctx) {
    return ctx.commands.register({
        name: 'compose',
        description: '叠 叠词\\ 下全部注释表 + <工作区名>-剩余.txt，写 叠词\\<工作区名>.txt；不出则报明缺什么',
        handler: invocation => runCompose(ctx, invocation),
    })
}
