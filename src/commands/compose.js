/**
 * /compose —— 叠注释表 → 成品；带一句主题时，那句定成品首行，产物形态由它决定。
 *
 * 与两条提取命令的分工：
 *   /dieci             无参数：工作区素材 → 叠词\工作区-注释.txt + 工作区-剩余.txt
 *   /supplement <题目>  要题目：剩余文本 → 叠词\<题目>-注释.txt
 *   /compose           无参数：叠词\ 下全部 *-注释.txt + 工作区-剩余.txt → 叠词\<工作区名>.txt
 *   /compose <主题>     那句写死成首行，形态交给模型按主题判断（要什么产物出什么产物），
 *                      落盘 叠词\<工作区名>-指定主题.txt
 *
 * 口径（全部写死，无开关）：
 *   · 注释表 = 叠词\ 下全部，先 <工作区名>-注释.txt（管内容）、后其余 <题目>-注释.txt（补规格与约束），同一后缀靠题目区分
 *   · 剩余文本 = 工作区根目录的工作区-剩余.txt
 *   · 成品只有一份，重跑覆盖
 *   · 每一步经 ctx.tools.execute 派发，与模型直接调用同一套策略、守卫与日志
 */

import path from 'node:path'
import { makeToolRunner } from '../core/dispatch.js'
import { OUT_DIR, workspaceRoot } from '../core/paths.js'
import { workspaceName } from '../core/text.js'

/** 成品名里主题的截断上限：太长系统不好处理，留余量 */
const THEME_NAME_MAX = 40

/**
 * 用主题本身当文件名：剥掉文件名非法字符，压空白，过长截断。
 * @param {string} theme 用户给的主题
 * @returns {string} 干净的文件名片段；主题全被剥光时回落「指定主题」
 */
function themeFileName(theme) {
    const cleaned = String(theme ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, THEME_NAME_MAX)
    return cleaned || '指定主题'
}

/**
 * 派发一次工具调用：与模型直接调用同一套策略、守卫与日志（见 core/dispatch.js）
 */
const runTool = makeToolRunner({ prefix: 'compose-cmd' })

/**
 * 执行一次成稿。
 * @param {object} ctx 带 tools 服务的上下文
 * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
 * @returns {Promise<{ kind: 'success'|'error', text: string }>}
 */
export async function runCompose(ctx, invocation) {
    const root = workspaceRoot(invocation, ctx)
    const givenTheme = String(invocation?.rawInput ?? '').trim()

    const out = givenTheme
        ? path.join(root, OUT_DIR, `${workspaceName(root)}-${themeFileName(givenTheme)}.txt`)
        : path.join(root, OUT_DIR, `${workspaceName(root)}.txt`)

    const res = await runTool(ctx, invocation, 'compose', givenTheme ? { out, theme: givenTheme } : { out })
    if (!res.ok) {
        return {
            kind: 'error',
            text: ['/compose 失败', '', res.text].join('\n'),
        }
    }

    return {
        kind: 'success',
        text: [
            '/compose 完成',
            `工作区：${root}`,
            `成品：${out}`,
            givenTheme ? `主题：${givenTheme}` : '主题：由模型定',
            '',
            res.text,
        ].join('\n'),
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
        description: '叠 叠词\\ 下全部注释表 + <工作区名>-剩余.txt：不带参数出散文；带一句主题则写死首行、产物形态由主题决定',
        handler: invocation => runCompose(ctx, invocation),
    })
}
