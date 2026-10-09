export const compileDieciTool = {
  name: 'compile_dieci',
  description: '最后一步：把评估通过的叠词文件展开成成品（完整文稿），写入工作区。',

  parameters: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        description: '工作区目录的绝对路径'
      },
      filename: {
        type: 'string',
        description: '要编译的叠词文件名（不含 .txt 后缀）'
      },
      output: {
        type: 'string',
        description: '成品文件名（不含后缀）。如果不填，默认在 filename 后加「_成品」'
      }
    },
    required: ['workspace', 'filename']
  },

  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }]
  },

  async execute(args) {
    // TODO: 读取叠词文件，按注释与关系材料展开成成品并写入
    return `[compile_dieci] 待实现。收到参数：${JSON.stringify(args)}`
  }
}
