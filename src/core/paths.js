/**
 * 产物的路径与命名：工具与命令共用同一份定义，改一处即全局生效。
 *
 * 原来这些常量在 7 个文件里各写一遍（OUT_DIR 四份、-注释.txt 三份、工作区
 * 解析函数五份），改一个后缀要改五处、漏一处就两边不一致。集中在这里。
 *
 * 纪律：本文件不碰 fs，只做常量与纯计算。
 */

/** 注释表目录：<工作区>\叠词\ */
export const OUT_DIR = '叠词'

/** 注释表后缀：<题目>-注释.txt（dieci 的题目是工作区名，supplement 的题目由用户给） */
export const PLAIN_SUFFIX = '-注释.txt'

/** 剩余文本后缀：<工作区名>-剩余.txt */
export const REMAIN_SUFFIX = '-剩余.txt'

/** 文件名里不能出现的字符 */
export const ILLEGAL_IN_NAME = /[\\/:*?"<>|\u0000-\u001f]/gu

/**
 * 工作区根目录。
 *
 * 三级来源，取第一个可用的：
 *   1. 会话创建时的 cwd —— 这才是「用户的会话工作区」，也是沙箱边界
 *   2. fs 服务的 config.cwd —— 全局解析默认值，通常是进程启动目录
 *   3. process.cwd()
 *
 * 工具的 exec 与命令的 invocation 都是这个形状（都有 agent.session.header），
 * 所以两处共用同一个实现。
 *
 * @param {object} exec 工具调用上下文或命令 invocation
 * @param {object} ctx 插件上下文（可选；给了才查 fs 服务）
 * @returns {string} 绝对路径
 */
export function workspaceRoot(exec, ctx) {
    const headerCwd = exec?.agent?.session?.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd) return headerCwd

    const fsService = ctx && typeof ctx.get === 'function' ? ctx.get('fs') : undefined
    const fxCwd = fsService?.config?.cwd
    if (typeof fxCwd === 'string' && fxCwd) return fxCwd

    return process.cwd()
}
