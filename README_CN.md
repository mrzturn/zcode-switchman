# zcode-switchman

<!-- [2026-09-16]-[document the new code-comment format iron rule]-[README now covers the [COMMENT]/[Comment] surfaces and their opt-out] -->
<!-- [2026-09-16]-[document the model/thoughtLevel hands-off ownership contract]-[both pins survive every sync verbatim; only creation writes the built-in inherit] -->

[English](./README.md) | **中文**

> 壳各就各位，模型你来定。

一个 [ZCode](https://zcode.dev) 编排插件，与 [opencode-switchman](https://github.com/mrzturn/opencode-switchman) 同源，是它的 ZCode 移植版。核心就两件事：

**1. 固定六档子代理编队。** economy / mechanical / main / hard / vision / review，一档一壳。装完插件开个会话它们就自动就位：缺的创建，过期的同步，出故障的熔断隔离。壳名永不改——换模型不动任何 prompt、文档和肌肉记忆。

**2. 模型与思考档位行是你的私产。** ZCode 的子代理注册是静态的，跑起来换不了模型，所以这一版把它完全交给你：所有壳默认 `model: inherit`，跟着会话默认走；想钉死哪档，就在那档的 frontmatter 里改 `model:` 行（`/switchman-setup` 可对话式改模型行），`thoughtLevel:` 思考档位同样是手改的一行。两行都是用户私产：你设了什么就跑什么——插件不检查、不评判、不改写、不丢弃，插件升级和每次会话启动都不会动它。插件唯一会写的是创建壳文件时内置的 `model: inherit`；已存在的壳文件里，这两行是什么就是什么（没设就不会被凭空加上）。

在此之上：

- **派发有纪律**。错档派发在结构上就难成立：派发时壳名已钉死，只读/看图壳的工具白名单由平台强制。hook 补上平台给不了的那层：连续派发失败自动熔断，到点自愈，每次拦截都说明该改派哪档。
- **发布即脱敏**。仓库里只有通用模板和代码，任何真实的服务商、套餐、模型绑定、配额口径都不入库——你的绑定只存在于你的家目录。

## 和 opencode-switchman 的差异

同源同作者，六档编队、DELEGATION_V1 委派协议、同伴技能都是同一套。差异来自宿主：OpenCode 插件跑在宿主进程里，平台给得多；ZCode 插件是声明式组件加独立进程 hook，给不了的就砍掉——包括 ROUTE_META 校验闸：编队固定、子代理注册静态，平台已经钉死了壳并强制其工具白名单，这道闸没有可守的东西了。

| | [opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 版） | 本仓库（ZCode 版） |
|---|---|---|
| 壳矩阵 | 动态，发现模型就生成壳，运行时可换 | 固定六档，壳名不变 |
| 模型调度 | 自动：加权评分、配额感知、探测、高峰避让 | 手动：每壳一行 `model:`，你说了算 |
| 上下文水位控制 | 有：实测水位、读类闸门、软硬水位、自动备份压缩 | 没有 |
| 会话交接 | 全自动：fork 备份、压缩、无缝续作 | compact 档 Stop 驱动写交接文档，你按一次 `/compact` 后文档自动注入续作（`/switchman-handover` 命令引导同样可用）；fork 由你在客户端菜单自行决定 |
| 界面 | TUI 面板 + tmux 窗格镜像 | 会话横幅 + 4 个 slash 命令 |

想看完整形态，去[源仓库](https://github.com/mrzturn/opencode-switchman)；想看这份取舍的来龙去脉，看[移植设计文档](./docs/porting-handover.md)。

## 安装

在 ZCode 客户端里：**Settings → Plugin Management → Discover**，点 **`+`** 添加 marketplace，填本仓库地址 `https://github.com/mrzturn/zcode-switchman`（仓库根带 `marketplace.json`；本地路径也行），然后在插件卡片上点 **Get**。装完即默认启用。

嫌麻烦就让 AI 替你装，把下面这段话复制给 ZCode：

<details>
<summary><strong>AI 代安装提示词</strong></summary>

```text
请为我的 ZCode 安装 zcode-switchman 插件。以仓库 README 为准，不要凭记忆猜步骤。

官方来源：https://github.com/mrzturn/zcode-switchman

步骤：
1. 先读该仓库 README 的「安装」一节，然后照做：Settings → Plugin Management → Discover，用「+」把该仓库添加为 marketplace，再在插件卡片上点 Get 安装。
2. 装完重开一个 ZCode 会话，确认启动横幅里有 [Session] 和 [Shells] 行，[Shells] 列出 switchman-economy / mechanical / main / hard / vision / review 六个壳。
3. 在会话里运行 /switchman-doctor，七项自检全部通过。

三步都通过才算完成；请汇报你做过的改动，并附上横幅与 doctor 输出作为证据。
```

</details>

**前置条件**：ZCode 客户端，以及 `PATH` 上的 Node.js ≥ 18。hooks 以 `node` 子进程运行，没有 node 时插件按 fail-open 静默失效——`/switchman-doctor` 的第一项就是查这个。

## 快速上手

1. **装插件，重开会话。** 启动横幅的 `[Shells]` 行列出六壳，它们已被装配进 `~/.zcode/agents/`（Settings → Subagents 可见）。若当前会话早于装配，下一个会话就能看到。
2. **（可选）钉模型。** 默认 `model: inherit` 已经够用；想让某档跑固定模型，用 `/switchman-setup` 对话式改绑，或手改 `~/.zcode/agents/switchman-<档位>.md` 的 `model:` 行。宿主在**每个父轮开始时**都会重读 agent 定义，改完下一条消息即生效——运行中的子代理仍用它启动时的快照，不受影响；重开会话也能在 `[Binding]` 横幅行看到新绑定。打算频繁改的按档钉死，用下面可选的**矩阵**模式变成一份数据文件。
3. **正常干活。** 不用记任何新命令：主模型按 `switchman-routing` 技能挑档派发（每轮 `[ROUTE]` token 账铁律兜底），你也可以直接说「这活派给 hard」。委派一律走 DELEGATION_V1 模板；连续失败自动熔断。
4. **心里没底就体检。** `/switchman-doctor`，七项自检。
5. **会话跑长了就交接。** 两条路、一个流程：你自己跑 `/switchman-handover`，或者让会话自己来——到达 compact 档（默认 150k）后，模型第一次试图收尾时 Stop hook 会阻断一次，让它自己把版本化交接文档和指针写好。无论哪条路，指针都会被自动拾取：你按一次 `/compact`，交接文档全文注入新上下文，从 Next steps 无缝接着干（`handover.01.md`、`handover.02.md`…每次执行都生成新版本，从不动旧文件）。（超过 16KB 的文档降级为指针行；fork 备份由你在客户端会话菜单自行操作。）

state 目录默认 `~/.zcode/state/`（可用 `ZCODE_SWITCHMAN_STATE` 覆盖），存熔断状态 `routing.json` 和失败记录 `failures.log`。本插件的命令在 `/` 菜单里显示为 `$switchman-setup` 这样的形式，是同一批命令。

## 核心功能

**核心**

- **自装配编队**——SessionStart hook 在每次会话启动时把六壳装配进 `~/.zcode/agents/`：缺失的从模板创建，过期的正文同步到当前模板（插件升级零操作生效）。`model:`/`thoughtLevel:` 行归你，壳正文归模板，同步永不碰你钉过的行——设了的行原样透传，没设的行绝不注入；只有创建壳文件那一次会写入内置的 `model: inherit`。
- **派发门禁与熔断**——PreToolUse hook 给每次壳派发过一道闸：失败熔断。10 分钟内失败 2 次熔断该壳 10 分钟；not-found 类错误只熔断被请求的名字，拼错壳名不牵连健康壳。错档派发不需要闸：派发时壳已钉死，ro/看图的工具白名单由平台强制。非 switchman 代理原样放行；门禁自身坏了 fail-open，绝不挡活。
- **ro 壳的只读 Bash**——review / economy / vision 三壳带上 Bash，但只放行查看/搜索类命令（工具白名单只能放行工具名、放不了命令级，所以闸在 PreToolUse hook 里）：`git status/diff/log/show/blame` 一族、`rg/grep/cat/ls/head/tail`、`cd` 前缀与 `git -C` 形式（子代理 Bash 每次调用会重置 cwd）、管道——复合命令逐段判定，每段都得过。写入与改状态（`git commit/push/checkout`、`sed -i`、`find -delete` 等）、重定向到真实文件、命令/进程替换一律拒绝并给出可执行的改法提示；`2>&1` 与 `/dev/null` 目标放行。壳身份从它自己的 rollout 日志尾部解析（`request.toolNames`——平台落定的工具清单，无 Edit/Write 类工具即 ro），rw 壳的 Bash 不受影响，尾部读不出来时 fail-open。0.13.0 起，自 opencode-switchman 的 RO_BASH_PERMISSION 平移。

**辅助**

- **会话横幅**——每次启动注入 `[Session] / [Shells] / [Binding] / [Sync] / [Breaker] / [Workspace] / [Context] / [Rule] / [Comment]`；装配有变动才出现 `[Sync]`，有待交接时多一行一次性的 `[Handover]`；`[Context]`（实时用量估算 + 档位名）只在算得出数字时出现。
- **项目语言偏好**——每个项目记住自己的对话/注释/文档语言。没配置过的项目，在改动任何东西之前模型必须先回答三道 `switchman-lang` 问题，期间改文件和派发都被门禁拦着；答案落盘 `<project>/.switchman/settings.json`，之后 `[LANG]` 铁律每轮重注入。你临时提的语言要求只对当轮生效。门禁的项目根是会话锚定的（src/lib/project.mjs：每会话只定一次——环境变量项目目录或初始 cwd 向上最近的 `.switchman`/git 属主，缓存在 `~/.zcode/state/session-roots.json`，HOME 永不匹配），`cd` 进子目录不会再让配置"消失"而重关门禁，捕获写入与门禁检查始终同一个根，拦截文案直接给出它检查的绝对路径；且会话内门禁一旦打开就不会再关（绝无年中反复追问用户）。
- **代码注释格式铁律**——模型写下的每一条代码注释都按 `[yyyy-mm-dd]-[why]-[impact]`（日期-原因-影响，如 `[2026-09-16]-[guard empty payload before parse]-[prevents the restart loop]`）：日期取当天，why 写代码本身看不出来的原因或约束，impact 写对行为或读者的影响。管的是新增和大改重写的注释，任意语言的注释语法都算；提交信息、生成的文档、未触碰的存量注释除外，注释用语仍跟项目注释语言走。与其他铁律同机制贯穿始终：每轮用户输入重注入一行 `[COMMENT]`（压缩后依旧在；首启语言询问压住 `[ROUTE]` 时它照常注入——纯样式规则不诱导任何会被门禁拦的动作），开场横幅同步加 `[Comment]` 行。默认全局开启；`.switchman/settings.json` 顶层 `"commentRule": "off"` 可关。
- **db-query 技能引导**——只提示、绝不拦截地引导模型用 `db-query` 技能：用户输入像查库（双语关键词 + SQL 语句形状）时，当轮注入一行 `[DB]`；Bash 命令里出现裸数据库客户端（`mysql` / `mysqldump` / `redis-cli` 等）时，PreToolUse 再给一条非阻塞提示——正是模型要绕开技能的那一刻。检测是启发式的，可能漏报误报，但一条提示行代价极小，所以永不做拦截。`.switchman/settings.json` 顶层 `"dbHint": "off"` 可关。
- **compact 档读预算**——ZCode 给的唯一入口侧杠杆（`updatedInput`）：从 compact 档（≥ `contextTiers[2]`，默认 150k）起，超限的 Read——`limit` 缺省或高于 `readBudgetLines`（默认 200 行）——由 PreToolUse hook 在飞行中封顶；平台对改写后的输入重新校验并执行封顶后的调用，工具结果上附一行说明（实时用量、上限、以及出路：按需请求具体的 offset/limit 窗口）。封顶只会收窄，`offset` 原样保留，显式 `pages`（刻意的 PDF 阅读）绝不触碰；改写是不节流的入口管控——不消费任何一次性标记，advisory / strict 拒绝体系在其他受守卫调用上照常每轮一次。壳会话到不了这里；`"dispatch": "off"` 或 `"contextEstimate": "off"` 一并关停。
- **Stop 驱动的自动交接**——交接不再依赖用户记得跑 `/switchman-handover`：到达 compact 档后，模型第一次试图收尾时，Stop hook 阻断一次（`decision: "block"`，宿主连续续跑上限 3 次），阻断附带的上下文指示它按插件自己的 `commands/switchman-handover.md` 写好版本化交接文档 + 指针再结束回合。每会话一次（`.switchman/stop-handover.json`，独立标志文件）；交接指针已存在时跳过（用户已备好交接，无需二次驱动）；壳会话与 `"dispatch": "off"` / `"contextEstimate": "off"` 下静默；处处 fail-open——驱动器坏了绝不困住会话收尾。
- **逐轮交接拾取**——SessionStart hook 会在会话启动时注入待交接文档，但它的闩锁是一次性的，会话内 `/compact` 后不会再触发；因此 UserPromptSubmit hook 每轮检查指针，且只在上下文真实缩水后交付：指针记录写入时的水位（`est`），实时水位远低于它（确实压缩过——`HANDOVER_COMPACT_MARGIN`，30k）才注入并消费指针（文档小则全文、过大则路径行）。没压缩就继续干的会话，指针原封不动留给未来真正的新上下文；无 `est` 的旧式/手写指针按 fail-open 交付。
- **派发台账**——每条 Agent/Task 结果记成 state 目录 `dispatches.jsonl` 的一行 JSONL（档位归类、结果、后台启动句柄，以及 Agent 工具结果自带的用量合计：token 数、工具调用数、耗时）——零额外模型流量的派发记账；严格静默（记账绝不给派发结果附加任何内容），文件 512KB 封顶。失败记录仍归熔断的 PostToolUseFailure hook 管。
- **矩阵驱动重绑（可选）**——完整版路由器在 ZCode 上的唯一合法形态：`.switchman/settings.json` 顶层 `"matrix": "on"` + 用户私有的矩阵文件 `.switchman/shells.json`（`{"lanes": {"main": {"model": "provider/model", "thoughtLevel": "high"}}}`），插件把已定义档位的 `model:`/`thoughtLevel:` 钉进壳的 frontmatter——会话启动时（装配之后，`[Matrix]` 横幅行汇报）和每轮用户输入各应用一次，而宿主每个父轮都重读 agent 定义，所以**改矩阵下一条消息即生效**：轮粒度的模型轮换，调用粒度不合法、文件粒度合法。矩阵开启时只对它定义了的档位拥有这两行；未定义的档位原样不动，删掉条目也不回置（避免意外重置）。矩阵关闭 → 插件绝不碰这两行，与所有权契约始终承诺的完全一致。
- **图像中继（可选）**——给文本-only 主模型用：`"imageRelay": "on"` 后，对光栅图片的 Read 被拒绝并附上正路——把路径经 DELEGATION_V1 派给 switchman-vision、引用它的结论（平台只允许 hook 给工具结果附加内容、绝不许改写，所以拒绝附改派就是 ZCode 合法形态的中继）。默认关闭——有视觉的主模型绝不该被引离自己的读取；vision 壳自己的图片读取永远放行。
- **派发优先纪律（token 账）**——每轮注入 `[ROUTE]` 铁律：动手前先用一句话权衡自己做还是派出去（自己做花主上下文且持续膨胀、压缩丢细节；派发花一个全新壳上下文，主上下文只付委派单和结论），并把当前上下文长度纳入考虑——越长越倾向派发；琐事（单行修改、看一两个已知文件、`.switchman/` 记账、协调编队）留给自己。开场横幅同步加 `[Rule]` 行。`.switchman/settings.json` 顶层 `"dispatch": "off"` 可关；`"dispatch": "strict"` 保留两行并在动态 `[ROUTE]` 块尾追加 strict 语义——超过上下文守卫阈值后，受守卫的自用工具调用每轮被拒一次（附改派指引），重新发起同一调用即可继续。0.7.0 起 `[ROUTE]` 行携带实时数字：用量估算自 CLI rollout 日志尾部（`~/.zcode/cli/rollout/model-io-<session>.jsonl`；`inputTokens` 即全量提示口径、已含缓存命中——已用面板数据确认；session_title 之类的辅助请求会被跳过），分档按绝对用量收紧——free（<80k）琐事留给自己 / frugal（80–120k）只许 ≤3k 产物自己做（单文件小修、记账、协调）/ tight（120–150k）只许 <1k 产物、120k 起先刷新交接文档 / compact（≥150k）先写好交接文档，再 `/compact` 或开新会话。开场横幅的 `[Context]` 行显示同一数字与档位；PreToolUse 上下文守卫对 Write / Edit / MultiEdit / NotebookEdit / Read / Glob / Grep 在超过 `contextWarnAt`（默认 120k，取 compact 前一档起点、随 `contextTiers` 联动；显式设置优先）时触发——默认 fleet 档注入每轮一次的非阻塞提醒，strict 档改为当轮第一条受守卫调用直接拒绝（重发同一调用即放行），`"dispatch": "off"` 则整体跳过守卫。总开关：`"contextEstimate": "off"` 全部关闭，`"contextWindow"` 设分母（默认 1M），`"contextCacheReadFactor"` 校准缓存读取（默认 0），`"contextTiers"` 覆盖三档边界（默认 `[80000, 120000, 150000]`）。
- **外来 agent 拦截面**——路由规则在派发时刻的兜底：当 Agent/Task 派发的 `subagent_type` 精确命中内置通用 agent（`Explore` 或 `general-purpose`，忽略大小写）——实证观察到的漂移：模型一边引用 `[ROUTE]` 一边仍把探索任务派给内置 Explore、从不加载路由技能——PreToolUse 钩子在派发时刻把它引回编队。`.switchman/settings.json` 顶层 `"foreignAgent"`：`"nudge"`（默认，缺省/非法值均兜底到此）对每次命中的派发注入一行非阻塞提示，指名等价档（Explore → economy「bulk light retrieval/triage」，general-purpose → main「day-to-day implementation」）与 DELEGATION_V1——不节流，每个派发决策点都该听到；`"strict"` 每轮首次命中的外来派发拒绝一次——拒绝文案含等价档与 DELEGATION_V1，重发同一调用即放行，当轮后续外来派发静默放行；`"off"` 完全静默。专用内置 agent（`documents:visual-judge` 等）、外来编队、无 `subagent_type` 的派发与所有 `switchman-*` 壳一律放行，且项目设 `"dispatch": "off"` 时整个门休眠。strict 标志存独立状态文件（`.switchman/foreign-agent-deny.json`），与上下文守卫互不干扰，每轮随用户输入重置。
- **壳上下文守卫与 HANDOFF 接力**——壳会话在工具调用时按绝对 token 水位收到分档注入（`contextShellTiers`，默认 `[30000, 50000, 70000]`，每档每壳只注入一次）：30k 收紧读法（精准 grep、只引必要段落）/ 50k 不再开启新阶段，完成手头单元后交接 / 70k 立即交接、进度标 partial。rw 壳先落盘版本化 handover（`.switchman/<date>/<lane>-shell/handover/`），ro 壳在最终消息内嵌紧凑交接块，交接结果一律以 `HANDOFF: <path|inline> · progress: n/m · next: …` 标记收尾——`switchman-routing` 技能的接力规则让主会话读它并按 Next steps 派新鲜壳续作（已否决路线随单携带，档位可自由换道）。`"contextEstimate": "off"` 连同此守卫一起关闭。
- **项目工作区 `.switchman/`**——壳的落盘输出、scratch 分析、交接文档统一放项目根的 `.switchman/`，不散落源码目录。建议加进项目的 `.gitignore`。
- **四条命令**——`/switchman-setup` 钉模型、`/switchman-doctor` 体检、`/switchman-handover` 交接、`/switchman-lang` 重设语言偏好。
- **四个技能**——`switchman-routing`（派发协议），以及自源项目原样平移的三个同伴：`git-commit-message`（只产出提交文案，绝不执行 git）、`requirement-docs`（需求/PRD/设计文档规范）、`db-query`（内置脚本只读核验 MySQL/Redis，拒绝一切写操作）。

## 文档

- 派发协议（六档怎么挑、DELEGATION_V1 怎么写，模板正文内联在技能里）：[skills/switchman-routing/SKILL.md](./skills/switchman-routing/SKILL.md)
- 委派 prompt 模板（人类参考副本；模型读上面内联的那份，测试保证两份字节一致）：[assets/delegation-template.md](./assets/delegation-template.md)
- 移植设计文档（平台差异、取舍、目标结构）：[docs/porting-handover.md](./docs/porting-handover.md)

## 仓库结构与契约

```
templates/agents/   六壳正本，会话启动自动装配到 ~/.zcode/agents
src/lib/            共享核心：shells / breaker / provision / handover / lang / state /
                    route（dispatch 模式解析，settings.json 顶层开关：off 关停、
                    strict 启用守卫的每轮一次拒绝，fail-open；
                    [ROUTE]/[Rule] 两行铁律文案唯一渲染出处：renderRouteLine / renderRuleLine）
                    comment-rule（代码注释格式铁律，默认开、commentRule 顶层开关可关；
                    [COMMENT]/[Comment] 两行文案唯一渲染出处：renderCommentRuleLine / renderCommentBannerLine）
                    dbhint（只提示不拦截的 [DB] 引导：提示词意图 + 裸客户端 Bash 提示；dbHint 开关可关）
                    context（[ROUTE] 实时数字与 [Context] 横幅行背后的 rollout 尾部用量估算，
                    fail-open，contextEstimate 开关可关）
                    readbudget（compact 档 Read 封顶，走 PreToolUse updatedInput；
                    readBudgetLines 设置项）
                    foreign-agent（派发时刻拦截面：Agent/Task 的 Explore/general-purpose
                    引向等价档；foreignAgent nudge/strict/off 开关）
                    autohandover（Stop hook 的 compact 档交接驱动；每会话一次、独立标志文件）
                    ledger（派发记账：state 目录每条 Agent/Task 结果一行 JSONL，
                    封顶、严格静默）/
                    matrix（可选的矩阵驱动壳重绑：会话启动与每轮把档位钉进壳
                    frontmatter；matrix on + .switchman/shells.json）/
                    imagerelay（可选的图片 Read 拒绝附改派，引向 vision 壳；
                    imageRelay on）/
                    dashboard（编队仪表盘的数据装配 + HTML 渲染：派发台账最近
                    记录、最新会话的实时水位、breaker 熔断、.switchman/settings.json
                    原样开关；每块独立 fail-open）
mcp/                dashboard-server：零依赖 stdio MCP server，把编队仪表盘作为
                    唯一一份服务端渲染的 HTML 资源交付（只实现 initialize +
                    resources/read——不声明任何 model 可见工具，面板对会话上下文
                    的 token 成本严格为零；重开面板即刷新；经
                    .zcode-plugin/plugin.json 的 ui.surfaces 接线）
hooks/              SessionStart · UserPromptSubmit · PreToolUse · PostToolUse
                    （lang-capture + dispatch-ledger）· PostToolUseFailure · Stop
commands/           setup · doctor · handover · lang
skills/             switchman-routing + git-commit-message / requirement-docs / db-query
test/               契约测试（node --test test/*.test.mjs）
```

改代码前扫一眼这几条，都有测试锁定：

1. 壳名 `switchman-<档位>` 是稳定标识，小版本绝不改。
2. `model:` 与 `thoughtLevel:` 行归用户，壳正文归模板；装配同步永不改写、不丢弃、不注入这两行（仅创建时内置 `model: inherit`）。唯一例外是开启后的可选矩阵：它对自己定义了的档位拥有这两行（src/lib/matrix.mjs）。宿主每个父轮都会重读 agent 定义，改动下一条消息即生效，无需重开会话。
3. deny 必附言：每次拦截都说明该改派哪个档位。
4. 门禁处处 fail-open：坏了写 stderr、放行，不挡活。
5. `.switchman/handover.json` 指针由 `/switchman-handover`（或 Stop 驱动的自动交接）写入，一次性消费——会话启动归 SessionStart hook；会话内则由逐轮的 UserPromptSubmit 拾取，且只在实时水位远低于指针写入时的 `est`（真实发生过压缩）才交付；从不压缩的会话指针原样保留。
6. 缓存纪律：所有 hook 注入都是追加式（`additionalContext` 落成新的尾部条目，宿主不允许 hook 改写历史），且每段注入的协议文本对输入确定（无时间戳、无会话 id）——prompt 缓存前缀永不被扰动，DELEGATION_V1 模板保持字节稳定，被派发的壳始终享受温暖前缀。

## 计划与展望

- [x] 派发记账（每条派发的档位、耗时、结果）——派发台账（0.18.0）
- [x] 完整版路由器：矩阵驱动的壳重绑（0.19.0）——六个壳文件永不改名；用户私有矩阵文件由 hook 在会话启动与每轮写进 frontmatter，轮粒度重绑搭宿主每轮刷新的便车
- [x] 无视觉主模型的图像中继（0.19.0）——可选的拒绝附改派，引向 switchman-vision
- [ ] 探测矩阵集成（可选，需显式开启）——派发台账已在记录真实的每派发用量/时延，矩阵可以直接按观测流量打分，不必主动探测
- [x] 编队仪表盘：架在派发台账 + 实时水位上的 MCP Apps 面板（`ui.surfaces`）（0.20.0）——不声明任何 model 可见工具：面板数据全部服务端渲染进一份 HTML 资源（派发台账 / 最新会话水位 / breaker / 设置摘要），对会话上下文的 token 成本严格为零；重开即刷新
- [ ] 逐壳 userConfig 开关——平台事实（2026-10 于 ZCode 源码验证）：插件 `userConfig` 的值只进 MCP server 配置和设置 UI；hook 进程读不到（hook 变量展开白名单固定：`ZCODE_PLUGIN_ROOT`/`_DATA`/会话 id）。因此开关继续放 `.switchman/settings.json`，等有 MCP 面板再承载。

有想法欢迎开 issue。

## 为爱发电

和 opencode-switchman 同源同作者。如果这套东西帮到了你，请作者喝杯咖啡的二维码在源仓库的[为爱发电](https://github.com/mrzturn/opencode-switchman/blob/main/README.zh.md#为爱发电)一节。

## License

MIT，见 [LICENSE](LICENSE)。
