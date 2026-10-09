export const relateLocalTool = {
  name: 'relate_local',
  description: '第②步：在本地工作区中检索与主题相关的内容（已有的叠词文件、笔记等），建立本地关系。',

  parameters: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        description: '工作区目录的绝对路径'
      },
      topic: {
        type: 'string',
        description: '主题关键词，用于匹配本地相关内容'
      }
    },
    required: ['workspace', 'topic']
  },

  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }]
  },

  async execute(args) {
    // TODO: 扫描 workspace，按 topic 匹配本地文件内容
    return `[relate_local] 待实现。收到参数：${JSON.stringify(args)}`
  }
}
