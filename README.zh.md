# dsh-paste-collapse

把 DeepSeek Harness 输入框里的大段粘贴折叠成 Codex 同款占位符，叠一枚可点开的胶囊，
并在模型读到这一轮之前由宿主把全文换回去。

模型收到的仍然是你粘贴的每一个字符。插件不写磁盘，也不省 token —— 占位符只是让输入框
更好读，不是压缩。

```
你粘贴 12000 个字符
        │
        ▼
输入框显示   [Pasted Content 12000 chars]   外加一枚带预览的胶囊
        │
        ▼  你按发送
宿主把占位符换回原文
        │
        ▼
模型读到完整的 12000 个字符
```

## 规则（与 Codex 完全一致）

| | |
|---|---|
| 阈值 | 1000 字符（Codex 的 `LARGE_PASTE_CHAR_THRESHOLD`） |
| 占位符 | `[Pasted Content 12000 chars]` |
| 同尺寸第二次粘贴 | `[Pasted Content 12000 chars] #2`，第三次 `#3`…… |
| 编号方式 | 按字符数分别计：3000 字符的粘贴自己从 1 开始 |
| 展开顺序 | FIFO：占位符第 k 次出现对应第 k 段原文 |
| 找不到原文的占位符 | 原样保留，照样发给模型 |

占位符文本、编号规则和 FIFO 展开都是 Codex
（`codex-rs/tui/src/bottom_pane/chat_composer.rs`）的移植：`next_large_paste_placeholder`
与 `expand_pending_pastes`。

## 胶囊

每段被折叠的粘贴都会在输入框上沿生成一枚胶囊：

* 粘贴内容的第一行，最多 24 个字符
* 字符数
* 点一下在右侧打开全文抽屉

抽屉就是 Codex 与 WorkBuddy 那种侧边面板：全文、字符数、复制按钮、关闭按钮；
按 `Esc` 或点面板外即可关闭。

胶囊配色全部走 DSH 原生 CSS 变量（不写死十六进制），跟随明暗主题。

## 安装

```bash
# 在 DSH profile 里
dsh plugin add dsh-paste-collapse
```

或者链接本地目录：

```json
{
  "dependencies": {
    "dsh-paste-collapse": "link:D:\\work\\huanghao\\dsh-paste-collapse"
  }
}
```

插件分两半：宿主端（`lib/index.js`）负责展开占位符，客户端端（client.js）负责把粘贴
折叠成占位符并画出胶囊。

## 边界

* **原文只存在内存里。** 宿主用一个普通数组保存粘贴内容，不写磁盘、不上传，宿主进程
  结束后就没了。
* **宿主重启后原文会丢。** 占位符还留在输入框里，但宿主已经不知道原文，发送时占位符
  会原样发给模型。胶囊会把它标成「原文已丢失」。
* **不省 token。** 模型读到的仍然是全文，和直接粘贴一模一样。插件只解决输入框可读性。
* **宿主不答应就不折叠。** 宿主调用失败或超过 1.5 秒超时时，粘贴内容按原文插入，绝不
  丢字。
* **用户删掉占位符就作废。** 客户端和宿主都会忘掉这段原文，下次同样大小的粘贴重新从
  裸占位符开始。

## 与 Codex 的差异

只有两处：

1. **展开时机。** Codex 在输入框里展开，DSH 在宿主的 `agent/pre-step` 里展开，也就是模型
   读到这一轮之前。
2. **占位符的样子。** Codex 只显示纯文本，DSH 在纯文本占位符之上再加一枚胶囊。

## 测试

```bash
node --check lib/marker.js
node --check lib/index.js
node --check client.js
node test/run-tests.mjs      # 38 条：marker 规则 + 客户端 bundle
node selftest/host-e2e.mjs   # 17 条：宿主端到端
```

`test/client-bundle.mjs` 在假 window、假 React、假 DOM 里跑 `client.js`，不用浏览器也能
验证输入框行为；`selftest/host-e2e.mjs` 在假 Cordis 上下文里跑宿主插件，`DSH_HOME` 指向
临时目录。

完整验收清单见 [VERIFY.md](./VERIFY.md)。

## 许可

MIT
