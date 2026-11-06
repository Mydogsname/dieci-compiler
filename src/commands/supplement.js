/**
 * /supplement —— 有题提取，不接受路径参数，只收题目。
 *
 * 与 /dieci 的分工：
 *   /dieci       无参数：扫描工作区 → 逐份自检 → dieci → compose
 *   /supplement  要一句题目：把这句话交给 supplement 工具，从剩余文本里取句成表
 *
 * 口径（全部写死，无开关）：
 *   · 题目 = 命令名之后的原文，去首尾空白；空则返回用法，不调模型
 *   · 只做一步，不接 compose —— 补一次常常只是试探题目值不值得，自动出成品会白烧一次调用并覆盖已有成品
 *   · 剩余文本沿用工具规则：工作区根目录下唯一的 *-剩余.txt；多份则报错列出，要求自己整理
 *   · 产物：叠词\<题目>-注释.txt，以及被削薄的剩余文本、追加一行提取记录
 *   · 每一步经 ctx.tools.execute 派发，与模型直接调用同一套策略、守卫与日志
 */

import { makeToolRunner } from '../core/dispatch.js'
import { workspaceRoot } from '../core/paths.js'

const USAGE = '用法：/supplement <题目>　例：/supplement 夜间照明的画面约束'

/** 派发一次工具调用：与模型直接调用同一套策略、守卫与日志（见 core/dispatch.js） */
const runTool = makeToolRunner({ prefix: 'supplement-cmd' })

/**
 * 执行一次补充。
 * @param {object} ctx 带 tools 服务的上下文
 * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
 * @returns {Promise<{ kind: 'success'|'error', text: string }>}
 */
export async function runSupplement(ctx, invocation) {
    const topic = String(invocation?.rawInput ?? '').trim()
    if (!topic) return { kind: 'error', text: USAGE }

    const root = workspaceRoot(invocation, ctx)
    const res = await runTool(ctx, invocation, 'supplement', { input: topic })
    if (!res.ok) {
        return {
            kind: 'error',
            text: [`/supplement 失败（题目：${topic}）`, '', res.text].join('\n'),
        }
    }

    return {
        kind: 'success',
        text: [`/supplement 完成（题目：${topic}）`, `工作区：${root}`, '', res.text].join('\n'),
    }
}

/**
 * 注册 /supplement。
 * @param {object} ctx 带 commands 与 tools 服务的上下文
 * @returns {unknown} 注册句柄
 */
export function registerSupplementCommand(ctx) {
    return ctx.commands.register({
        name: 'supplement',
        description: '有题提取：按给定题目从剩余文本取句，写 叠词\\<题目>-注释.txt，并削薄剩余文本',
        handler: invocation => runSupplement(ctx, invocation),
    })
}
