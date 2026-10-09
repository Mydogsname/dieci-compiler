import { makeMemorySaveTool } from './tools/memory_save.js'

export const name = 'dieci-compiler'

// sessions 和 workspaceRegistry 是可选宿主能力
// 它们由 dsh-workspace 提供，宿主未加载时插件保持 pending
export const inject = ['tools', 'sessions', 'workspaceRegistry']

export function apply(ctx, config = {}) {
  console.log('>>> [叠词编译器] 已加载')

  ctx.tools.register(makeMemorySaveTool({
    ctx,
    subdir: config.memorySubdir ?? '记忆',
    fallbackWorkspace: config.workspace
  }))
}