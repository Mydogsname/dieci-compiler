export const relateWebTool = {
  name: 'relate_web',
  description: '第③步：检索外部来源（网页、资料），为主题建立外部关系，补充本地没有的材料。',

  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: '主题关键词'
      },
      keywords: {
        type: 'array',
        description: '额外的检索关键词',
        items: { type: 'string' }
      }
    },
    required: ['topic']
  },

  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }]
  },

  async execute(args) {
    // TODO: 调用搜索/抓取能力，汇总外部资料
    return `[relate_web] 待实现。收到参数：${JSON.stringify(args)}`
  }
}
