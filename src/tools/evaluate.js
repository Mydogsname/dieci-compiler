export const evaluateTool = {
  name: 'evaluate',
  description: '第④步：评估已收集的材料（结构化内容 + 本地关系 + 外部关系），判断质量与缺口，给出是否可进入编译的结论。',

  parameters: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        description: '工作区目录的绝对路径'
      },
      filename: {
        type: 'string',
        description: '要评估的叠词文件名（不含 .txt 后缀）'
      }
    },
    required: ['workspace', 'filename']
  },

  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }]
  },

  async execute(args) {
    // TODO: 读取文件与关系材料，输出评估结论
    return `[evaluate] 待实现。收到参数：${JSON.stringify(args)}`
  }
}
