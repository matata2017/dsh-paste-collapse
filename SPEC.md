# dsh-paste-collapse — 规格书

> 目标：粘贴的长文本在 DSH 输入框里折叠成一枚绿色胶囊（对齐 WorkBuddy 截图），
> 而**模型收到的仍然是全文**（对齐 Codex 的 `[Pasted Content N chars]` 占位符 + 提交时展开）。

本文件是实现规格。开发代理请逐条实现并自测；测试代理请独立验收。

---

## 0. 事实依据（已核实，不要重新推翻）

**Codex 的做法**（`D:\work\huanghao\codex-src\codex-rs\tui\src\bottom_pane\chat_composer.rs`）
- `const LARGE_PASTE_CHAR_THRESHOLD: usize = 1000;`（:457）——超过 1000 字符的粘贴换成占位符。
- 文档注释「Large Paste Placeholders」（:215-223）：占位符标签由字符数派生，首次为
  `[Pasted Content N chars]`，同尺寸的多次粘贴加 `#2`、`#3` 后缀。
- 全文存在 `pending_pastes: Vec<(String, String)>`，**提交时** `expand_pending_pastes`（:1484）展开回全文。
  → Codex 只折叠 UI，**不省 token**，模型收到的是原文。

**占位符编号算法（必须逐字照抄，`next_large_paste_placeholder`，:1921-1943）**
```rust
let base = format!("[Pasted Content {char_count} chars]");
let prefix = format!("{base} #");
let mut max_suffix = 0usize;
for (placeholder, _) in &self.draft.pending_pastes {
    if placeholder == &base { max_suffix = max_suffix.max(1); continue; }
    if let Some(suffix) = placeholder.strip_prefix(&prefix) && let Ok(value) = suffix.parse::<usize>() {
        max_suffix = max_suffix.max(value);
    }
}
if max_suffix == 0 { base } else { format!("{base} #{}", max_suffix + 1) }
```
→ 编号**按字符数分别计**：粘两次 2000 字得到 `[Pasted Content 2000 chars]` 与
`[Pasted Content 2000 chars #2]`；接着粘 3000 字又是 `[Pasted Content 3000 chars]`。

**展开算法（必须逐字照抄，`expand_pending_pastes`，:2561-2604）**
1. 按占位符建索引：`HashMap<&str, VecDeque<&str>>`，同一个占位符的原文按加入顺序排队。
2. 按出现顺序遍历文本，把**第 k 个**某占位符替换成该占位符队列里的**第 k 段**原文（`pop_front`）。
3. 找不到对应原文的占位符**原样保留**（不会被吃掉）。
→ 我们的实现没有「文本元素/字节区间」那层（Codex 用 TextElement 标出占位符的 byte range），
我们直接在字符串上做同样的 FIFO 替换，语义等价。

**DSH 的机制**（`D:\work\huanghao\dsh-src\packages\client\ui-conversation`）
- 输入框是 Lexical 编辑器；`conversation.input.overlay` 槽渲染在输入框卡片内部、
  编辑器之上（`skeleton/InputBar.tsx:403-405`，`data-composer-card` / `data-composer-overlay`）。
- 插件组件能拿到公开的输入动作面（`contract/slots.ts:330-337` `SessionStandardProps.inputActions: InputActions`）：
  - `captureInsertion(): TokenSpan` —— 取当前选区/光标（带草稿版本号）
  - `insertText(text, span): boolean` —— 在该位置插入纯文本（一步撤销）
  - `setDraft(text)`、`submit()` 等
- **插 chip 的 API 是私有的**：`insertReference` 只在 `InputTarget`/`SessionInput` 上
  （`contract/input.ts:176-182`），插件拿不到；`InputActions` 只有纯文本插入。
  → 所以折叠态用**我们自己的胶囊 UI + 草稿里的文本占位符**实现，不用 DSH 原生 chip。
- 粘贴手势本身是 InputBar-private（`contract/input.ts:245` 注释：paste 句柄不随该 face 暴露），
  但 **DOM 的 `paste` 事件插件拦得到**。
- 宿主侧 `agent/pre-step` 允许**改写消息**：
  `PreStepDecision = { kind:'reject' } | { kind:'enter', messages: UserMessage[] }`
  （`packages/core/agent/src/runtime-types.ts:111-119`）。

**本仓库可参考的既有实现**：`D:\work\huanghao\dsh-hoos`（`dsh-codex-hooks` 插件，v0.5.2）。
它已经跑通了「宿主 + 客户端双端插件」的完整骨架，本插件按同样的骨架写：

| 需要的能力 | `dsh-codex-hooks` 里的位置 |
| --- | --- |
| 宿主远程方法（SRC 描述符） | `lib/index.js` 的 `HooksController` + `DESCRIPTOR_KEY` |
| 客户端调宿主 | `client.js` 里 `connection.rpc.call('/api', 'hooks/<method>', { args })` |
| 客户端注册插槽 | `client.js` 的 `client.slots.inject(<slot>, () => client.slots.register({...}, Component))` |
| 客户端 bundle 测试 | `test/client-bundle.mjs`（假 React/DOM 渲染组件） |
| 宿主自检 | `selftest/host-e2e.mjs`（把 DSH_HOME 指到临时目录） |

---

## 1. 产品行为

1. 用户在输入框里粘贴 **> 1000 字符**的纯文本：
   - 这段文本**不进入编辑器**，草稿里被替换成占位符 —— 格式与 Codex 完全一致：
     `[Pasted Content <N> chars]`，同尺寸的第二次起 `[Pasted Content <N> chars #2]`、`#3`……；
   - 输入框上方出现一枚**绿色胶囊**：绿色圆角底、左侧一个 "T" 文本图标、右侧截断预览（例如 `太猛了！充雨溪团队推…`）、末尾显示字符数；
   - 点胶囊 → 展开显示全文（可滚动），再点收起。
2. 粘贴 ≤ 1000 字符：**完全不动**，走 DSH 默认行为。
3. 提交这一轮时，宿主把草稿里的占位符**换回全文**再交给模型
   → 模型看到的用户消息与「没折叠直接粘贴」时**逐字相同**。
4. 宿主存不到那段文本时（例如宿主重启过）：占位符原样送给模型，胶囊上标注「原文已丢失」。

## 2. 包结构

工作目录 `D:\work\huanghao\dsh-paste-collapse`（新目录，独立包，可单独发布）：

```
package.json            name: dsh-paste-collapse, version 0.1.0, dsh.bundle.patch=./cordis.patch.yml,
                        dsh.client.platform=web, dsh.client.inject: ["@deepseek-ai/dsh-client-locale"]
cordis.patch.yml        id: dsh-paste-collapse, name: dsh-paste-collapse, inject: 客户端 locale
icon.svg                简单图标
locale/en.json locale/zh.json     只放 meta.*
lib/marker.js           纯函数（无 I/O）：阈值、Codex 占位符编号、FIFO 展开、预览截断
lib/index.js            宿主：apply(ctx) —— 提供远程方法 + agent/pre-step 展开
client.js               客户端：overlay 胶囊行 + 粘贴拦截
test/run-tests.mjs      单元测试
test/client-bundle.mjs  客户端渲染/交互测试
selftest/host-e2e.mjs   宿主端到端自检
README.md README.zh.md VERIFY.md
```

`lib/marker.js` 必须是**零依赖纯函数**（便于单测），导出：

```js
export const PASTE_THRESHOLD = 1000
// Codex 的编号规则：同尺寸首次用 base，第二次起追加 #2、#3……
export function nextPlaceholder({ charCount, pending })   // pending: Array<[placeholder, text]>
// Codex 的展开规则：按占位符建 FIFO 队列，第 k 个占位符 ← 第 k 段原文
export function expandPlaceholders(text, pending)        // → { text, used: number[] }
export function previewText(text, max = 24)               // → 首行 + 省略号
```

- `nextPlaceholder` 必须是上面那段 Rust 的逐字移植：
  - base = `[Pasted Content ${charCount} chars]`；prefix = `${base} #`；
  - 扫 `pending`：占位符等于 base → `maxSuffix = max(maxSuffix, 1)`；
    以 prefix 开头且后缀能解析成整数 → `maxSuffix = max(maxSuffix, 该整数)`；
  - `maxSuffix === 0` → 返回 base；否则返回 `${base} #${maxSuffix + 1}`。
- `expandPlaceholders(text, pending)`：
  - 按占位符建 `Map<string, string[]>` 队列（保持 pending 的加入顺序）；
  - 从头扫描文本，遇到占位符就取该队列的队首（`shift`）替换；队列空则**原样保留该占位符**；
  - 返回替换后的文本，以及被用掉的 pending 下标（宿主用来清理过期项）。
- 占位符的识别用**精确字符串匹配**（`pending` 里出现过的占位符），不要用宽泛正则去猜——
  这样用户自己敲的 `[Pasted Content 999 chars]` 不会被误当成占位符（Codex 同理：它只认自己登记过的）。

## 3. 客户端（client.js）

### 3.1 胶囊行

- 注册槽 `conversation.input.overlay`，id `dsh-paste-collapse/pills`，order 5，locale NS。
- 组件 `PastePills(props)`：
  - `props.inputActions` 可能为 undefined（无当前会话）→ 渲染空。
  - 维护本会话的待处理粘贴列表 `pending: Array<[placeholder, text]>`（组件内 state/ref，
    **与 3.2 拦截器共用同一份**，胶囊与占位符编号才不会错位）。
  - 每枚胶囊：**DSH 原生配色，不要 WorkBuddy 那种绿**（用户明确要求「换个好看点的颜色」）；
    用 DSH 的设计变量，自动适配深浅色：
    - 底色 `--dsw-alias-state-business-tertiary`（淡蓝），取不到就
      `color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)`
    - 边框 `0.5px solid var(--dsw-alias-border-l2)`
    - 文字 `--dsw-alias-label-primary-bluish`，取不到用 `--dsw-alias-label-secondary`
    - "T" 图标用 `--dsw-alias-state-business-primary`
    - 圆角 `var(--dsw-alias-radius-sm, var(--dsw-radius-sm, 8px))`
    - hover：`--dsw-alias-interactive-bg-hover`
    - 字符数用 `--dsw-alias-label-tertiary`
    （这些变量名取自 `D:\work\huanghao\dsh-src\packages\client\**\*.module.css` 的既有用法。）
  - 胶囊行整体 `position:absolute` 由宿主槽位容器负责定位，插件只需 `display:flex;gap:8px;flex-wrap:wrap`。
  - 胶囊的 key = 占位符字符串（Codex 那边占位符本身就是唯一标识）。
- 展开态：胶囊下方或弹层内显示全文（`max-height:240px;overflow:auto;white-space:pre-wrap`）。

### 3.2 粘贴拦截（关键实现细节）

- 组件挂载时：找输入框卡片 → `const card = node.closest('[data-composer-card]')`，
  编辑器 = `card.querySelector('[contenteditable="true"]')`。
- 在 **card 上以捕获阶段** 注册 `paste` 监听器：`card.addEventListener('paste', onPaste, true)`。
  捕获阶段在祖先上监听 → 早于 Lexical 挂在目标元素上的监听器，
  所以 `preventDefault()` + `stopPropagation()` 能保证 Lexical 收不到这段文本。
  （挂在编辑器自身上会晚于 Lexical 自己的监听器——**不要那样写**。）
- `onPaste(event)`：
  1. `const text = event.clipboardData?.getData('text/plain') ?? ''`；`text.length <= PASTE_THRESHOLD` → 直接 return（不拦截）。
  2. `event.preventDefault(); event.stopPropagation();`
  3. 按 Codex 规则算占位符：`const placeholder = nextPlaceholder({ charCount: text.length, pending: pendingRef.current })`
     （`pendingRef.current` 是本会话已登记的 `Array<[placeholder, text]>`，**客户端自己维护一份**，
     和 Codex 一样：composer 自己算编号）。
  4. 把原文交给宿主：`await call('paste/remember', { placeholder, text })`
     （沿用 `dsh-codex-hooks` 的 `connection.rpc.call('/api', 'paste/remember', { args })` 写法）。
     **失败或超时（≥1500ms）→ 不折叠**：改为把原文直接插入草稿（`insertText(text, span)`），
     胶囊也不出现、`pending` 也不登记。宁可长一点也不要把内容丢了。
  5. 插入占位符：`const span = props.inputActions.captureInsertion();`
     `const ok = props.inputActions.insertText(placeholder, span)`；
     `ok === false` → 再取一次 span 重试一次；仍失败 → 插入原文（并把刚才登记到宿主的这条撤掉：
     再调一次 `paste/remember` 带 `{ placeholder, text: null }` 表示撤销）。
  6. 成功后把 `[placeholder, text]` 追加进客户端的 `pending`，并加一枚胶囊
     （`{ placeholder, chars: text.length, text, expanded: false, lost: false }`）。
- 卸载时 `card.removeEventListener('paste', onPaste, true)`。
- `sessionId` **不是必需的**：宿主按占位符字符串排队即可。
- **宿主重启后**：`pending` 清空 → 占位符找不到原文，宿主原样保留它，胶囊上标注「原文已丢失」；
  这与 Codex 重启后行为一致（`pending_pastes` 也在内存里）。

### 3.2.1 占位符被删掉时（Codex 的清理规则，必须照做）

Codex 在**每次编辑草稿后**把「占位符已不在草稿里」的 pending 条目删掉：
- `chat_composer.rs:2053-2055`：`self.draft.pending_pastes.retain(|(placeholder, _)| text_after.contains(placeholder))`
- `chat_composer.rs:3804`：`self.draft.pending_pastes.retain(|(ph, _)| ph != removed)`（删掉某个占位符就删对应条目）

DSH 侧我们能读到草稿：标准 props 里有 `useInput: SnapshotSelectorHook<InputState>`
（`packages/client/ui-conversation/src/client/contract/slots.ts:334`），
`InputState.draft` 是「编辑器文档的剪贴板文本投影」（`contract/input.ts:283-284`），
`InputState.draftRev` 是草稿版本号。

- 组件里订阅 `useInput()`；`input.draftRev` 变化时执行
  `pending = pending.filter(([ph]) => input.draft.includes(ph))`（**同 Codex 的 retain 语义**）。
- 后果（与 Codex 一致）：用户把占位符删掉后，pending 条目随之消失 →
  下一次粘同样长度会**重新用 base**（`[Pasted Content 2000 chars]`），而不是接着 `#2`。
- 对应的胶囊标记为「已删除」或直接隐藏（Codex 没有胶囊，这只是我们 UI 的一致性处理）。
- 宿主侧同样要在展开时清理没用上的条目（`expandPlaceholders` 返回的 `used` 下标 → 删掉其余）。

### 3.3 样式

- 胶囊（**不要绿色**，用 DSH 原生淡蓝）：
  ```css
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 320px; padding: 4px 10px;
    border-radius: var(--dsw-radius-sm, 8px);
    border: 0.5px solid var(--dsw-alias-border-l2);
    background: var(--dsw-alias-state-business-tertiary,
      color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent));
    color: var(--dsw-alias-label-primary-bluish, var(--dsw-alias-label-secondary));
    font-size: 12px; line-height: 16px;
  }
  .pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .pill .icon { color: var(--dsw-alias-state-business-primary); }
  .pill .count { color: var(--dsw-alias-label-tertiary); }
  ```
- 预览文本：`overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`
- 展开面板：`background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm,8px);padding:8px;max-height:240px;overflow:auto;white-space:pre-wrap;font-size:12px;`
- 所有颜色都必须走 CSS 变量（跟随 DSH 深浅色主题），**不写死十六进制色值**。

## 4. 宿主（lib/index.js）

- `apply(ctx)`：
  1. `const pending = []`（`Array<[placeholder, text]>`，按登记顺序，纯内存）。
  2. `ctx.provide('pasteController', new PasteController(pending))`，
     远程方法描述符沿用 `dsh-codex-hooks` 的 SRC 写法，方法名 `paste/remember`，
     参数 `{ placeholder, text }`（`text === null` 表示撤销这一条），返回 `{ ok: true }`。
  3. `ctx.on('agent/pre-step', async (payload, next) => { ... })`：
     ```js
     const decision = await next()
     if (!decision || decision.kind === 'reject') return decision
     const messages = decision.messages ?? payload?.messages ?? []
     const expanded = mapUserText(messages, pending)   // 把占位符换回全文
     if (expanded === messages) return decision        // 没有占位符，不动
     return { ...decision, kind: 'enter', messages: expanded }
     ```
     - `mapUserText`：遍历消息，找到文本里含占位符的用户消息，用 `expandPlaceholders` 替换；
       保持消息其余字段不变；**只替换文本，不改角色、不加消息**。
     - 展开用 Codex 的 FIFO 规则：第 k 个某占位符 ← 该占位符队列里第 k 段原文；
       找不到原文的占位符原样保留。
     - 替换后占位符不见了 → 模型收到全文。
  4. 没有任何占位符时，行为与不装插件完全一致（不得改变 messages 数组引用以外的东西）。
- `pending` 同时提供 `size()`、`has(placeholder)`、`forget(placeholder)` 供自检断言。
- 宿主不写文件、不落盘（对齐 Codex：pending pastes 只在内存里）。

## 5. 测试

### 5.1 `test/run-tests.mjs`（单元）
- `PASTE_THRESHOLD === 1000`。
- `nextPlaceholder`（Codex 编号规则）：
  - 空 pending → `[Pasted Content 2000 chars]`；
  - 已有 base → `[Pasted Content 2000 chars #2]`；已有 `#2` → `#3`；已有 `#5` → `#6`（跳号补最大）；
  - **不同尺寸各自计号**：pending 里有 2000 字的 base，再问 3000 字 → `[Pasted Content 3000 chars]`；
  - 乱序 pending（先 `#3` 后 base）也要取最大后缀 +1。
- `expandPlaceholders`（Codex 展开规则）：
  - 一个占位符一次 → 换成全文；
  - **同一占位符出现两次、pending 里两段原文** → 第 1 次得第 1 段、第 2 次得第 2 段（FIFO）；
  - pending 缺一段 → 第二个占位符原样保留；
  - 用户手打的 `[Pasted Content 999 chars]`（未登记）原样保留；
  - 替换后其它文本不动。
- `previewText`：短文本原样；长文本截断并加省略号；换行只取第一行。

### 5.2 `test/client-bundle.mjs`（客户端）
沿用 `dsh-codex-hooks` 的那套假 React/DOM 渲染器（读它的文件抄结构，不要重新发明）：
- 渲染 `PastePills`，喂一个假的 `inputActions`（记录 `captureInsertion`/`insertText` 调用）。
- 造一个 2000 字符的 `ClipboardEvent`（`clipboardData.getData('text/plain')`）打到假 card：
  - 断言 `insertText` 收到 **`[Pasted Content 2000 chars]`**（不是带随机 id 的旧格式）；
  - 断言宿主调用 `paste/remember` 带上了 `{ placeholder, text }`（原文一字不差）；
  - 断言渲染出了胶囊且含预览文本与 `2000`。
- 再粘一次 2000 字符：断言占位符变成 `[Pasted Content 2000 chars #2]`；
- 粘一个 10 字符的：断言**没有**拦截（`insertText` 未调用、无宿主调用）。
- 断言组件卸载时监听器被移除。

### 5.3 `selftest/host-e2e.mjs`（宿主自检）
沿用 `dsh-codex-hooks` 的写法（`process.env.DSH_HOME` 指临时目录，绝不碰真实 `~/.dsh`）：
- 调 `paste/remember` 存一段文本（占位符 + 原文）；
- 触发 `agent/pre-step`，payload 的用户消息含占位符 → 断言返回的 `decision.messages` 里
  该用户消息的文本**等于全文**；
- 登记两段同占位符原文 + 消息里出现两次该占位符 → 断言按 FIFO 依次替换（第一段给第一处、第二段给第二处）；
- 触发一个不含占位符的 `agent/pre-step` → 断言 messages 原样（内容与顺序都不变）。

## 6. 验收标准

1. `node test/run-tests.mjs` 全绿（自己写多少断言就写多少，但至少 12 条）。
2. `node selftest/host-e2e.mjs` 全绿（至少 3 条）。
3. `node --check` 所有 JS 文件通过。
4. 装到 desktop profile 后（`dsh.profile.bundles` + link，参考 `dsh-codex-hooks` 的装法），
   粘贴一段 >1000 字符的文本：**输入框不炸、出现绿色胶囊、草稿里是占位符**；
   发送后模型收到全文。
5. README 中英双语写明：阈值 1000（对齐 Codex）、胶囊可点开看全文、
   宿主重启后原文会丢（占位符原样送出）、不省 token。

## 7. 与 Codex 的差异（只有两处，其余逐字照抄）

1. **展开时机**：Codex 在输入框里展开（客户端提交前）；我们在宿主 `agent/pre-step` 展开。
   原因：DSH 没给插件「提交前改写草稿」的可靠时机（`inputActions` 只有 `insertText`/`setDraft`，
   抢在 Enter 之前改写草稿有竞态）。
   对模型而言等价：占位符在**模型看到之前**就被换回全文。
2. **胶囊外观**：Codex 的 TUI 里占位符是纯文本 `[Pasted Content N chars]`；
   绿色胶囊是用户点名要的 WorkBuddy 样式（截图里那枚绿色圆角胶囊），
   我们在 Codex 的文本占位符之上另加一层胶囊 UI，草稿里仍留 Codex 原样的占位符文本。

其余全部照抄：阈值 1000、编号规则（`next_large_paste_placeholder`）、
FIFO 展开（`expand_pending_pastes`）、纯内存不落盘、模型收到全文（不省 token）。

## 8. 明确不做

- 不改 DSH 宿主/客户端任何源码（`D:\work\huanghao\dsh-src` 只读）。
- 不做 DSH 原生 reference chip（插件拿不到插 chip 的 API）。
- 不做省 token 的「存文件 + 路径」方案（用户已选「全文照旧发给模型」）。
- 不做导入、导出、跨会话共享。
- 不做 Codex 没有的功能（不存草稿历史、不做粘贴历史面板）。
