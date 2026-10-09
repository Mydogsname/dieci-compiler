import fs from 'node:fs/promises'
import path from 'node:path'

export const formatDieciTool = {
  name: 'format_dieci',
  description: `把用户零散的输入整理成规范的叠词文件，写入工作区。
格式规则：
- 第一行：标题
- 空一行
- 正文：用户的输入
- 空一行，写「注释：」，之后每行「词：内容」
- 注释的 value 可以为空（空注释 = 待补）

用户说"建个文件""记录一下""整理一下"时调用。只整理格式，不判断内容够不够。`,

  parameters: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        description: '工作区目录的绝对路径'
      },
      filename: {
        type: 'string',
        description: '文件名，不含 .txt 后缀'
      },
      title: {
        type: 'string',
        description: '第一行标题。不填则默认用 filename'
      },
      body: {
        type: 'string',
        description: '正文内容。可以是用户的原话，或 AI 整理后的要点'
      },
      notes: {
        type: 'array',
        description: '注释条目。每条 { key, value }。value 可以为空字符串，表示待补',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '注释的词，2-6 个字' },
            value: { type: 'string', description: '注释内容，可以为空' }
          },
          required: ['key']
        }
      },
      overwrite: {
        type: 'boolean',
        description: '文件已存在时是否覆盖。默认 false'
      }
    },
    required: ['workspace', 'filename']
  },

  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }]
  },

  async execute(args) {
    const { workspace, filename, overwrite = false } = args
    const title = (args.title || filename).trim()
    const body = (args.body || '').trim()
    const notes = args.notes || []

    // 过滤文件名非法字符
    const safeName = filename.replace(/[\\/:*?"<>|]/g, '_')
    const filePath = path.join(workspace, `${safeName}.txt`)

    // 覆盖检查：已存在则返回旧内容，让 AI 决定怎么办
    if (!overwrite) {
      try {
        const old = await fs.readFile(filePath, 'utf-8')
        return `文件已存在：${filePath}\n\n旧内容：\n${old}\n\n如要覆盖，请把 overwrite 设为 true。`
      } catch {
        // 文件不存在，继续
      }
    }

    // 拼内容
    const content = buildDieciContent(title, body, notes)

    // 写文件
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')

    return `已写入：${filePath}\n\n${content}`
  }
}

// 拼装叠词文件内容
function buildDieciContent(title, body, notes) {
  let out = title + '\n'

  if (body) {
    out += '\n' + body + '\n'
  }

  if (notes.length > 0) {
    out += '\n注释：\n'
    for (const n of notes) {
      const value = (n.value || '').trim()
      out += `${n.key}：${value}\n`
    }
  }

  return out
}