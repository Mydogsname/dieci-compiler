import { makeDecomposeTool } from './tools/decompose.js'
import { makeCheckNotesTool } from './tools/check_notes.js'
import { makeDieciTool } from './tools/dieci.js'
import { makeComposeTool } from './tools/compose.js'
import { registerChainCommand } from './commands/chain.js'
import { DIECI_GUIDE } from './guide.js'

export const name = 'dieci-compiler'

// 只声明真正用到的宿主能力：tools 是三个工具的唯一依赖。
// llm 由 ctx.get('llm') 运行时取，缺了只是调不到模型，不会让插件停在 pending。
// commands / systemPrompt 走可选注入，宿主没有就自动降级。
export const inject = ['tools']

export function apply(ctx) {

  // 拆解：源正文 → 语义单元，自检通过才落盘
  ctx.tools.register(makeDecomposeTool({ ctx }))

  // 检查：语义文件 ↔ 源文件对账（只读）
  ctx.tools.register(makeCheckNotesTool())

  // 叠词：多份语义文件 → 注释（词：原句）+ 残句
  ctx.tools.register(makeDieciTool({ ctx }))

  // 成品：注释 + 残句 → 成稿
  ctx.tools.register(makeComposeTool({ ctx }))

  // 系统提示段落：让每个会话默认明白叠词工作流的思路
  // 写法 A（优雅降级）：宿主没有 systemPrompt 服务时，其余工具照常工作
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'tool:dieci',
      order: 116,
      text: DIECI_GUIDE,
    })
  })

  // /chain：一条命令串 check_notes → decompose → check_notes → dieci
  // 可选注入：宿主没有 commands 服务时，三个工具照常工作
  ctx.inject(['commands'], (cmdCtx) => {
    registerChainCommand(cmdCtx)
  })
}
