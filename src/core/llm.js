import { createUserMessage, BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * 调模型的公共部分：decompose / dieci / supplement / compose 四个工具共用。
 *
 * 这里的每一处都不是可有可无的：
 *   · 一律 temperature 0 —— 同一份素材每次划分得到同一个结果；
 *   · 先显式请求 reasoningEffort=off —— 推理 token 与正文共享 maxTokens，
 *     会话档位高时模型会把配额全花在思考上，正文一个字都不剩；
 *   · provider 不认这个档位就退回默认档，而不是直接失败；
 *   · 截断要分开报「正文多少字 / 推理多少字」——两者处置完全不同。
 *
 * 纪律：本文件只负责「拿到模型的一段文本」，不解析、不落盘、不判断内容对错。
 */

/** 输出上限（含推理），可按需调 */
export const DEFAULT_MAX_TOKENS = 8192

/**
 * 这类「按格式照抄并分组」的任务不需要思考。
 * provider 不支持 off 时自动退回默认档，见 callModel。
 */
export const OFF_EFFORT = ReasoningEffortId('off')

/** 该 provider 不认这个推理档位时的报错特征 */
export const EFFORT_REJECTED = /reasoning effort|推理档/i

/**
 * 把一次截断说清楚：上限多少、正文与推理各产出多少字、正文开头是什么。
 * 「被截断」既可能是正文太长，也可能是推理吃光了配额——两者处置完全不同。
 */
export function describeTruncation(blocks, maxTokensUsed) {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('')
    const head = text.slice(0, 300) || '（空）'
    return [
        `输出被 maxTokens 截断（上限 ${maxTokensUsed}）：正文 ${text.length} 字，推理 ${reasoning.length} 字。`,
        reasoning.length > text.length
            ? '推理占了大部分配额——应关闭思考（reasoningEffort=off）或提高 maxTokens。'
            : '正文本身过长——请把源文件分段后再拆。',
        `正文开头：${head}`,
    ].join('\n')
}

/** 跑一次流，把「调用失败」与「正常结束」分开。 */
export async function streamOnce(ctx, exec, system, prompt, reasoningEffort) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (!llm?.stream) return { ok: false, kind: 'no-llm', error: '宿主没有 llm 服务' }

    const route = exec?.agent?.options ?? {}
    if (!route.provider || !route.model) {
        return { ok: false, kind: 'no-route', error: '拿不到当前会话的 provider/model' }
    }

    const maxTokensUsed = route.maxTokens ?? DEFAULT_MAX_TOKENS
    const messages = [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dieci-compiler' },
    })]

    const assembler = new BlockAssembler()
    try {
        for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model,
            messages,
            system,
            temperature: 0,
            maxTokens: maxTokensUsed,
            ...reasoningEffort === undefined ? {} : { reasoningEffort },
            signal: exec?.signal,
        })) {
            assembler.push(chunk)
        }
    } catch (err) {
        return { ok: false, kind: 'threw', error: `模型调用出错：${err?.message ?? err}` }
    }

    if (assembler.finish?.kind === 'error') {
        return { ok: false, kind: 'threw', error: `模型调用出错：${assembler.finish.failure?.message ?? '未知错误'}` }
    }
    if (assembler.finish?.kind === 'max-tokens') {
        return { ok: false, kind: 'truncated', error: describeTruncation(assembler.blocks(), maxTokensUsed) }
    }

    return {
        ok: true,
        text: assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('').trim(),
    }
}

/** 调模型：先请求 off（不思考），provider 不认这个档位就退回会话默认档。 */
export async function callModel(ctx, exec, system, prompt) {
    const first = await streamOnce(ctx, exec, system, prompt, OFF_EFFORT)
    if (first.ok) return first
    if (first.kind !== 'threw' || !EFFORT_REJECTED.test(first.error)) return first

    const second = await streamOnce(ctx, exec, system, prompt, undefined)
    if (second.ok) return second
    return {
        ok: false,
        error: `${second.error}\n（注：provider 不接受 reasoningEffort=off，已退回默认档；若仍被截断，说明思考占了预算。）`,
    }
}
