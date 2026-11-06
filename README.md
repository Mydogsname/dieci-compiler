# dieci-compiler（叠词）

把几份中文文档拆成「一句一行」，再按「词」把相关的句子配成对，最后只用这些配对出成品——成品里每个字都能追回到原文。

## 安装

从 GitHub 装：

```sh
pnpm dsh plugin --profile <profile> add github:Mydogsname/dieci-compiler
```

从本地目录装（改代码时）:

```sh
pnpm dsh plugin --profile <profile> add ./dieci-compiler
```

卸载：

```sh
pnpm dsh plugin --profile <profile> remove dieci-compiler
```

装完重启宿主，会话里就有五个工具、三条命令和一段系统提示。

本插件依赖 DSH 自带的 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-llm`，不自己带这两个包；实测于 `0.1.0-rc.5`。

## 五个工具

| 工具 | 作用 |
|---|---|
| `decompose` | 正文 → 语义文件（自检不过不落盘，重试 3 次） |
| `check_notes` | 只读对账：一句一行 / 保真 / 覆盖 / 组间空行 |
| `dieci` | 无题提取：多份语义 → 注释表 + 剩余文本 |
| `supplement` | 有题提取：剩余文本 + 题目 → 主题注释表 |
| `compose` | 注释表 + 剩余文本 → 成品 |

三条命令只是把它们串起来。要指定注释表层次或落点，直接调工具。

## 许可

MIT
