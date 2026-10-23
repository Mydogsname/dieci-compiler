# dieci-compiler（叠词）

生成有注释的提示词：源正文先被拆成「一句一行」的语义文件，多份语义文件再被叠成「词 → 原句（来源）」的配对。

## 它解决什么
ai遗忘，记错，控制ai的行为

## 安装

```sh
pnpm dsh plugin --profile <profile> add dieci-compiler
pnpm dsh --profile <profile> --dump-config   # 输出里应有 "# == dieci-compiler"
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

**三个工具**

| 工具 | 读写 | 作用 |
|---|---|---|
| `decompose` | 写 `语义/` | 正文 → 语义文件；自检通过才落盘，否则重试（最多 3 次）后报错不写 |
| `check_notes` | **只读** | 语义文件 ↔ 源文件对账：一句一行、保真、覆盖、组间空行 |
| `dieci` | 只读（可选落盘） | 多份语义文件 → 词与句的跨文件配对，可按 `out` 写文件 |

**一条命令**

| 命令 | 参数 | 作用 |
|---|---|---|
| `/chain` | 无 | 处理工作区全部 `.md`/`.txt`：逐份自检 → 缺/不合格的补 `decompose` 并复核 → 全部通过后 `dieci`，产物写 `<工作区>\叠词.txt` |

命令名受宿主约束：`^[a-z][a-z0-9_-]*$`，中文名不可用。

**一段系统提示** —— 每个会话默认就懂叠词工作流（`tool:dieci`，order 116）。

> `/dieci`、`/save` 仍未实现；`/chain` 是唯一实现的命令。

## 工作流

```
正文.md ──decompose──> 语义/正文-语义.txt ──┐
正文2.md ─decompose──> 语义/正文2-语义.txt ─┴─dieci──> 词 → 原句（来源）
                                └──check_notes──> 通过 / 未通过
```

`dieci` 在读素材前会先用同一份判据复核语义文件，不合格直接拒，不自动重新划分。

`/chain` 把上面这条链固化：`check_notes` 当闸门，缺/不合格才补 `decompose`，复核通过后进 `dieci`，任一步失败即中止并回前序步骤。素材取自工作区（递归，跳过 `语义\`、`node_modules`、`.git` 等目录和自己的产物），上限 30 份。

## 文件格式

语义文件（`语义/<主名>-语义.txt`）：

```
她叫沈青梧，二十七岁，在城南一家旧书店做店员。      ← 一句一行，原文一字不动
身高一米六五，偏瘦，肩膀窄，习惯微微含胸。
                                                     ← 空行 = 组界，恰好一行
脸型偏鹅蛋，下颌线条柔和，颧骨不高，皮肤偏冷白。
```

自检四条：

1. **一句一行**：每个非空行正好是源文按 `。！？；` 切出的一句，行序与正文一致
2. **保真**：行内文字与对应源句逐字相同（只忽略空白差异）
3. **覆盖**：源文每句都入语义文件，不多不少、不重复
4. **结构**：组与组之间恰好一个空行

注释格式（`dieci` 的产出）：`词：原句（来源文件）`，续行按两空格缩进。

## 源码结构

```
src/
├─ index.js        入口：注册三个工具 + 可选挂 /chain 与系统提示段
├─ guide.js        系统提示段正文
├─ core/text.js    判据本体：切句 / 解析 / 比对 / 路径（无 fs、无模型）
├─ tools/          decompose.js · check_notes.js · dieci.js
└─ commands/chain.js
```

## 配置

本包暂无可配字段。`maxTokens` 跟随会话路由（缺省 8192）；decompose 与 dieci 都以 `temperature 0` 调用模型，减少同一素材每次划分不一致。

## 许可

MIT
