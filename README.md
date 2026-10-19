# dieci-compiler（叠词）

生成有注释的提示词

## 它解决什么
ai遗忘，记错，控制ai的行为

## 安装

```sh
pnpm dsh plugin --profile <profile> add dieci-compiler
pnpm dsh --profile <profile> --dump-config   # 输出里应有 "# == dieci-compiler"
```
## 运行
```sh
pnpm dsh --profile <profile>
```

从目录装（开发时）：

```sh
pnpm dsh plugin --profile <profile> add ./dieci-compiler
```

卸载：

```sh
pnpm dsh plugin --profile <profile> remove dieci-compiler
```

## 装完有什么

**两个命令**

| 命令 | 作用 |
|---|---|
| `/dieci <主题>` | 生成提示词文件，并把「围绕主题成文」的活派给模型 |
| `/save [标题]` | 把最近一条回答保存成材料 |

**三个工具**

| 工具 | 读写 | 作用 |
|---|---|---|
| `find_sources` | **只读** | 跨文件找依据与已有定义 |
| `annotate` | 写既有文件 | 补注释 —— 本插件的主打 |
| `parse_prompt` | **只读** | 看注释状态与格式缺口 |

**一段系统提示** —— 每个会话默认就懂叠词工作流（`tool:dieci`，order 116）。

## 文件格式

```
标题                        ← 第 1 行，独占一行
（正文）
注释：                       ← 区标记，全角冒号，独占一行
词：内容                      ← 条目，顶格；词 = 2-12 个中文/字母/数字/下划线
  续行内容                    ← ≥2 空格缩进 = 上一条的续行
```
## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `memorySubdir` | `记忆` | 材料目录名 |
| `workspace` | 空 | 兜底工作区路径。留空则用会话 cwd |

覆盖方式写在你自己的 profile `cordis.patch.yml` 里，不必改本包。

## 许可

MIT
