// 检查语义文件与源文件是否一致
import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkNotes, semanticPathFor } from '../core/text.js'

// ─── 工具工厂 ───
export function makeCheckNotesTool() {
    return defineTool({
        name: 'check_notes',
        description: `检查语义文件与源文件是否一致。只读，不写盘。
【检查项】
- 一句一行：每个非空行必须正好是源文的一句，且行序与正文一致
- 保真：行内文字与对应源句逐字相同（只忽略空白差异）
- 覆盖：源文每句都进了语义文件，不多不少、不重复
- 结构：组与组之间恰好一个空行，无连续空行
【参数】
- file：源文件绝对路径，必填。
- note：语义文件绝对路径，可选；缺省取 源文件同目录/语义/<主名>-语义.txt。`,
        parameters: {
            file: {
                type: 'string',
                required: true,
                description: '源文件绝对路径',
            },
            note: {
                type: 'string',
                description: '语义文件绝对路径（可选，缺省取 语义/<主名>-语义.txt）',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },

        async execute(args) {
            try {
                const file = String(args?.file ?? '').trim()
                if (!file) return '检查失败：缺少 file 参数（源文件绝对路径）'
                if (!path.isAbsolute(file)) return `检查失败：file 必须是绝对路径（${file}）`

                const body = await fs.readFile(file, 'utf-8').catch(() => null)
                if (body === null) return `检查失败：源文件读不了（${file}）`

                const notePath = args?.note
                    ? String(args.note).trim()
                    : semanticPathFor(file, path)
                if (!path.isAbsolute(notePath)) {
                    return `检查失败：note 必须是绝对路径（${notePath}）`
                }
                const noteText = await fs.readFile(notePath, 'utf-8').catch(() => null)
                if (noteText === null) return `检查失败：语义文件读不了（${notePath}）`

                const r = checkNotes(body, noteText)

                const out = [
                    `源文件：${file}（${r.sentenceCount} 句）`,
                    `语义文件：${notePath}（${r.noteCount} 行 / ${r.groupCount} 组）`,
                ]
                out.push(r.bad.length
                    ? `保真：${r.bad.length} 行对不上源文（改字/编造/错位）\n` + r.bad.map(l => `  · ${l}`).join('\n')
                    : '保真：全部逐行对得上')
                out.push(r.missing.length
                    ? `覆盖：缺 ${r.missing.length} 句\n` + r.missing.map(s => `  · ${s}`).join('\n')
                    : '覆盖：无漏句')
                out.push(r.problems.length
                    ? `结构：${r.problems.length} 处问题\n` + r.problems.map(p => `  · ${p}`).join('\n')
                    : '结构：一句一行、组间一个空行')
                out.push(r.ok ? '结论：通过' : '结论：未通过——请重跑 decompose')
                return out.join('\n')
            } catch (err) {
                return `检查失败：${err?.message ?? err}`
            }
        },
    })
}
