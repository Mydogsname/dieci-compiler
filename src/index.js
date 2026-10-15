import { makeMemorySaveTool, registerTurnMemoryCheck } from './tools/memory_save.js'
import { makeAnnotateTool } from './tools/annotate.js'
import { makeParsePromptTool } from './tools/parse_prompt.js'
import { makeFindSourcesTool } from './tools/find_sources.js'
import { registerSaveCommand, registerSaveMemoryCommand } from './save_command.js'
import { DIECI_GUIDE } from './guide.js'

export const name = 'dieci-compiler'

// sessions 和 workspaceRegistry 是可选宿主能力
// 它们由 dsh-workspace 提供，宿主未加载时插件保持 pending
export const inject = ['tools', 'sessions', 'workspaceRegistry', 'commands']

export function apply(ctx, config = {}) {
  console.log('>>> [叠词编译器] 已加载')

  const subdir = config.memorySubdir ?? '记忆'

  ctx.tools.register(makeMemorySaveTool({
    ctx,
    subdir,
    fallbackWorkspace: config.workspace
  }))

  // 补全注释：往已有叠词文件的注释区填/追加条目
  ctx.tools.register(makeAnnotateTool({
    ctx,
    fallbackWorkspace: config.workspace
  }))

  // 只读检查：看叠词文件的注释状态（待补/缺依据/未识别行/警告），不写盘
  ctx.tools.register(makeParsePromptTool({
    ctx,
    fallbackWorkspace: config.workspace
  }))

  // 跨文件找来源与已有定义（只读）
  ctx.tools.register(makeFindSourcesTool({
    ctx,
    fallbackWorkspace: config.workspace
  }))

  // 漏存防线：turn 结束时检查本轮有没有漏存记忆（写 记忆/_待补.md）
  registerTurnMemoryCheck(ctx, { subdir })

  // 用户主动保存：/save（最近一条回答）+ /save-memory（界面按钮按 id 存）
  registerSaveCommand(ctx, { subdir })
  registerSaveMemoryCommand(ctx, { subdir })

  // 系统提示段落：让每个会话默认明白叠词工作流的思路
  // 写法 A（优雅降级）：宿主没有 systemPrompt 服务时，其余工具照常工作
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'tool:dieci',
      order: 116,
      text: DIECI_GUIDE,
    })
  })
}
