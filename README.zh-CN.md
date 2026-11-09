<div align="center">

# pi-btw

*问一句，别停下手里的活。*

[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950?style=flat-square&labelColor=black)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Finn763/pi-btw?style=flat-square&logo=github&labelColor=black)](https://github.com/Finn763/pi-btw/stargazers)
[![Pi extension](https://img.shields.io/badge/pi-extension-8957e5?style=flat-square&labelColor=black)](https://github.com/earendil-works/pi-coding-agent)

中文 | [English](README.md)

</div>

> Claude Code `/btw` 的 Pi 移植版。原版是从它发布的二进制里逆向读出来的。

你正卡在一件长任务中间，脑子里冒出一个问题——"这个函数到底干了啥？"——然后只有三条烂路：打断 agent、开个啥都不知道的新会话、或者记住等会儿再说。

`/btw` 是第四条路：一个继承了当前上下文的旁路提问，不带任何工具，一次回答就结束，主任务照常跑。

```
/btw net.ts 里那个 retry wrapper 到底捕获了什么？
```

---

## 为什么要做 pi-btw

拆掉"就在同一个窗口里问呗"的三个失败模式：

- **#1：问一句就等于打断。** 主任务停下，你的问题成了它的新优先级，原来那条线断了。**做法：** 旁路提问跑在独立实例上，有自己的 abort controller，主循环完全察觉不到。
- **#2：新窗口什么都不知道。** 新会话不知道"那个 retry wrapper"指什么，你得贴上下文、花五分钟。**做法：** 会话最近 40 条消息一起带过去，外加最多 20 条历史旁路问答。
- **#3：能动手的旁路提问就不是旁路提问了。** 如果它能读文件、跑命令、往回写记录，"随口一问"就变成第二个 agent 和第一个抢活。**做法：** `ctx.modelRegistry.complete()` 是裸补全。没有工具循环要关，没有轮次上限要拦，也不会往会话里写任何东西。

---

## 怎么跑的

```
┌──────────────────┐    /btw <question>    ┌─────────────────────┐
│  主对话继续跑     │ ────────────────────► │  旁路实例           │
│                  │                       │  无工具，一次回答    │
└──────────────────┘ ◄──────────────────── └─────────────────────┘
                      答案落在面板里
```

1. **提问** —— `/btw <问题>`。面板立刻出现并转圈，不等模型先开口。
2. **回答** —— 一次裸补全，会话上下文前置，系统提示把话说明白：没有工具、只答一次、不要叙述要做什么。
3. **看** —— 答案填进面板。长答案限制在约 45% 屏幕高度并可滚动，上面的对话始终可见。
4. **处置** —— 发到主对话（`f`）、追问（`r`）、复制（`c`）、关掉（`esc`）。

---

## 那把锁

没有工具循环，因为压根没有循环可跑。请求里连 `tools` 字段都不带：

```ts
const response = await ctx.modelRegistry.complete(
    model,
    { system: SIDE_SYSTEM, messages },
    { cacheRetention: "short", sessionId: uuidv7() },
);
```

系统提示再补一层模型不可能误读的话：

```
- You have NO tools available - you cannot read files, run commands, or search
- Do NOT write tool calls or tool output as text; nothing you write here is executed
- This is a one-off response - there are no follow-up turns
```

端到端验过：面板在 2 秒内带着 `⠴ Answering…` 出现；62 行的答案显示成 19 行可滚动窗口，而不是占满整个终端。

---

## 证明 `f` 真的进了模型上下文

`f` 用 `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: false })` 把这轮问答送进主对话——进上下文，但不触发新回合。验证它的那个实验：

```
/btw 请记住这个数字：8317。只回答 OK
→ OK
[f]
我刚才用 /btw 让你记住的数字是多少？只回答数字
→ 8317
```

`8317` 除了那次旁路提问，在任何地方都没出现过。主对话答出来了，说明旁路问答真的进了上下文。

---

## 安装

```bash
git clone https://github.com/Finn763/pi-btw.git
pi install ./pi-btw
```

然后在运行中的会话里 `/reload`。用 `pi list` 确认，应该能看到你克隆到的那个路径。

需要 Pi 1.5+（`@earendil-works/pi-coding-agent`）。

---

## 按键

```
/btw <问题>    提问
/btw           重开最近一次
```

| 键 | 动作 |
|---|---|
| `esc` / `enter` | 关闭 |
| `↑` `↓` | 长答案滚动（面板最多占约 45% 屏幕） |
| `c` | 复制答案到编辑器 |
| `r` | 追问——关闭并预填 `/btw ` |
| `f` | 把这轮问答送进主对话 |
| `←` `→` | 翻看更早的旁路问答 |

---

## pi-btw 钉住的几条

- **上下文** —— 会话最近 40 条消息，加上最多 20 条历史问答。这个上限是故意的：巨大的会话不该变成巨大的旁路请求。
- **历史** —— 只在内存里，20 条，Pi 退出即丢。跟 Claude Code 一样。
- **只答一次** —— 永远没有第二轮、没有工具调用、不写会话记录。
- **不触发回合** —— `f` 只加上下文，不让 agent 开口。

---

## 这东西哪来的

Claude Code 把 `/btw` 编进了一个 Bun 单文件二进制。这里的实现是从里面读出来的：旁路提问的系统提示是逐字的，"一次回答、没有工具"的契约一致，20 条历史上限也一致。

两处不同。Pi 的 `complete()` 让"无工具"变成结构上的保证而不是防御，所以 Claude Code 里那四层兜底（`canUseTool` 拒绝、`tool_use` 改写、XML 工具调用检测）在这里不需要。另外 `f` 是把问答送进主对话，而不是分叉一条新分支——因为那才是真正有人要的。

---

## 参与

欢迎 issue 和 PR。整个东西就一个文件（`btw.ts`，约 330 行），除了 Pi 自带的之外没有依赖。

## License

MIT
