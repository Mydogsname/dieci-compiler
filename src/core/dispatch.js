import { ToolCallId } from '@deepseek-ai/dsh-llm'

/**
 * 派发一次插件内工具调用，把「工具层面的失败」与「业务层面的结论」分开。
 *
 * 三条命令共用：经 ctx.tools.execute 派发，与模型直接调用走同一套策略、守卫与日志。
 *
 * 成败只认工具返回的字段（见 core/result.js）：
 *   value.ok     —— 这一步成没成
 *   value.passed —— 仅 check_notes：语义文件合不合格（是结论，不是失败）
 * 不读文案。工具的报错措辞随便改，这里都不会跟着误判。
 *
 * @param {{ prefix: string }} opts prefix 是调用号前缀（日志里能看出是哪条命令派的）
 * @returns {(ctx: object, invocation: object, name: string, args: object) => Promise<{ ok: boolean, passed?: boolean, text: string }>}
 */
export function makeToolRunner({ prefix }) {
    let seq = 0

    return async function runTool(ctx, invocation, name, args) {
        let res
        try {
            res = await ctx.tools.execute({
                callId: ToolCallId(`${prefix}:${++seq}:${name}`),
                name,
                arguments: args,
                agent: invocation.agent,
                signal: invocation.signal,
            })
        } catch (err) {
            return { ok: false, text: `${name} 调度失败：${err?.message ?? err}` }
        }

        // 工具抛错、参数不合格、超时：宿主都会给 isError
        if (res?.isError) {
            return { ok: false, text: `${name} 执行失败：${res.error?.message ?? '未知错误'}` }
        }

        const value = res?.value
        if (!value || typeof value !== 'object') {
            return { ok: false, text: `${name} 返回了意外结果（应为 { ok, text }）：${String(value).slice(0, 200)}` }
        }
        return {
            ok: value.ok !== false,
            passed: value.passed,
            text: String(value.text ?? ''),
        }
    }
}
