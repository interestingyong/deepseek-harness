# Agent Note：Composer PageUp/PageDown 草稿历史回溯

Status: implemented

[English](2026-09-11-composer-pgup-pgdn-draft-recall.md) | 中文

## Problem

Web 端 composer 的草稿是一次性的：发送过的消息想迭代只能重新输入（或从 transcript 里费力复制），也无法回看同一会话中更早的提示词。Codex 这类终端 agent 用输入历史漫游解决了这个问题；Web UI 需要等价手势，同时又不能抢占补全菜单或可编辑区已有的按键。

## Decision

**漫游本会话已提交的草稿绑定到两个手势：PageUp/PageDown 与方向键 Up/Down。** 两者都按 'older' 向前、'newer' 向后，遵循 shell 历史惯例：第一次 'older' 先暂存当前草稿，到达最老条目时钉住（后续 'older' 仍被消费，避免可编辑区跳滚），越过最新条目的一步恢复暂存内容。漫游状态以 package-private 的游标+暂存形式挂在 `SessionInputShell`（[facade.ts](../../../../packages/client/ui-conversation/src/client/input/facade.ts)）上，`recall(direction)` 并入 `ComposerKeyboard` 门面，使输入栏像其他手势一样对它进行门控。

**PageUp/PageDown 在 composer 根元素上挂普通 keydown 监听**——Lexical 没有对应命令——composer 之外的会话滚动不受影响，修饰键组合保持原生行为，IME 组合期间不漫游，被拒绝的漫游（无历史、adjudicating/submitting 忙碌阶段、补全菜单打开）落回原生受限可编辑区滚动。

**方向键 Up/Down 经由 Lexical 的 `KEY_ARROW_*_COMMAND` 以 CRITICAL 优先级触达漫游，但仅当光标位于文档首行/末行时**（[keymap.ts](../../../../packages/client/ui-conversation/src/client/input/editor/keymap.ts)，`caretAtVerticalBoundary`），因此多行草稿中方向键仍可逐行移动光标。单行 composer 短路为始终漫游——shell 提示符语义，即用户最先伸手去按的 Codex TUI 手势——因为没有第二行可供方向键穿行。边界判定读取已提交的编辑器状态（不是新开 update：命令处理器已运行在 Lexical 的 keydown 派发内部，此时 `editor.read` 会启动嵌套 update 并抛错），因此光标仍在按键前的位置。补全菜单仲裁先于漫游，打开的菜单保留方向键供自身遍历。

**列表本体是 per-Session Conversation store 的 `history` 键**（[stores.ts](../../../../packages/client/ui-conversation/src/client/stores.ts)），与草稿一起持久化，回溯因此跨刷新、跨会话切换存活。写入策略集中在 store 的 `pushHistory`：连续重复条目合并（shell 历史风格），尾部限定 200 条。shell 在 Enter 时记录精确的剪贴板投影（chip 已折叠为 `/command` / `@ref` 文本形式，回放的行会在扫描时重新装饰）；纯空白草稿与仅附件发送不产生记录。绑定/解绑管线与 `bindDraftMirror` 对齐：`bindHistory` 经由 `conversation.session` slot 注入，在同一个挂载 effect 中接线，渲染期 ref 为 shell 的惰性读取 thunk 提供最新列表。

## Alternatives considered

**像 Codex TUI 那样无条件拦截方向键。** 与多行纯文本编辑器的光标移动冲突；所采纳的边界规则（首/末行、单行短路）让方向键在多行间仍是光标移动键，同时给单行草稿以 shell 提示符手势。

**从会话 transcript 读历史。** transcript 是分页、虚拟化的——深层条目可能尚未加载到客户端，且其文本是序列化（chip 展开）后的形态而非用户输入的原样。composer 自有列表记录的是确切的输入内容，代价是忽略同一会话在其他窗口提交的提示词。

**只在 shell 内存里保存列表。** 刷新或会话拆除后即丢失；既有持久化 Conversation store 本来就承载 per-Session 的 composer 状态，追加一个键才是对称的归属。

**对所有重复连同序一起去重。** 重发会改变语义（重发条目应像任何提交一样落到尾部），且每次追加需要 O(n) 扫描而无用户可见收益。

## Consequences

`ConversationStoreState` 新增可选的 `history` 键（可选是因为发布前的持久化层整体替换状态，旧 blob 中没有该键），`ComposerKeyboard` 新增 `recall`，`conversation.session` 注入 props 新增 `bindHistory`；两个构造该 entry 的测试 harness 同步补上新 prop。200 条上限是与 `HISTORY_MERGE_DELAY_MS` 并列的产品常量，不是配置项。回放的命令行在提交时重新走 adjudication 而非恢复原有 claim（claim 是选取时刻的状态），与重新输入的行为一致。包级测试覆盖漫游、去重/上限策略、按键路由与提交时的游标重置。