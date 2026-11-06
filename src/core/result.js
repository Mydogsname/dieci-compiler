/**
 * 工具的统一返回结构：{ ok, text }。
 *
 * 为什么不再「返回一段中文、命令读文案判断成败」：
 * 命令那样做时，报错措辞改一个字（「拆解失败：」→「拆解未成功：」），失败就会被
 * 静默判成成功，然后带着一个根本没落盘的结果往下跑。判据必须是字段，不是散文。
 *
 *   ok   —— 这一步干成了没有（命令只认它）
 *   text —— 给人看的整段说明（模型与界面看到的都是它，措辞随便改）
 */

/**
 * 成功。
 * @param {string} text 给人看的说明
 * @returns {{ ok: true, text: string }}
 */
export function ok(text) {
    return { ok: true, text: String(text) }
}

/**
 * 失败。
 * text 的首行照旧写「XX失败：」，但那只是给人读的——判据是 ok 字段。
 * @param {string} text 给人看的说明
 * @returns {{ ok: false, text: string }}
 */
export function fail(text) {
    return { ok: false, text: String(text) }
}

/**
 * 工具的 output 契约：{ ok, text }，渲染成一段纯文字。
 * render 决定模型与界面看到什么；它读的永远是 text，不是判据。
 */
export const TEXT_OUTPUT = {
    schema: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', required: true, description: '这一步成没成' },
            text: { type: 'string', required: true, description: '给人看的整段说明' },
        },
        additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
}
