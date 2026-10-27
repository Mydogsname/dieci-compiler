import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 提取记录：谁、按什么题目、拿走/生成了多少句、还剩多少。
 *
 * 单独一份小文件，不往剩余文本里加头部——剩余文本是一句一行的语义集合，
 * 任何头部都会被 dieci 的 parseSemantic、compose 的剩余文本读取当成一句正文。
 *
 * 位置：工作区根目录\提取记录.txt（与剩余文本同在根目录）。
 */
export const RECORD_NAME = '提取记录.txt'

/** 时间戳：YYYY-MM-DD HH:mm */
function stamp() {
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 一行记录。
 * @param {string} who 工具名：dieci / supplement
 * @param {string} topic 那一次提取的题目
 * @param {string} detail 细节：supplement 写「取走 N 句 剩余 M 句」，dieci 写「生成 N 句」
 * @returns {string}
 */
export function recordLine(who, topic, detail) {
    return `${stamp()}\t${who}\t题目：${topic}\t${detail}`
}

/**
 * 追加一行；写不进去不抛，返回 false 由调用方决定怎么报。
 * @param {string} file 记录文件绝对路径
 * @param {string} line 一行文本
 * @returns {Promise<boolean>}
 */
export async function appendRecord(file, line) {
    try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, line.endsWith('\n') ? line : line + '\n', 'utf-8')
        return true
    } catch {
        return false
    }
}
