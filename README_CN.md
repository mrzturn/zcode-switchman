# zcode-switchman

[English](./README.md) | **中文**

> 壳各就各位，模型你来定。

一个 [ZCode](https://zcode.dev) 编排插件，与 [opencode-switchman](https://github.com/mrzturn/opencode-switchman) 同源，是它的 ZCode 移植版。核心就两件事：

**1. 固定六档子代理编队。** economy / mechanical / main / hard / vision / review，一档一壳。装完插件开个会话它们就自动就位：缺的创建，过期的同步，出故障的熔断隔离。壳名永不改——换模型不动任何 prompt、文档和肌肉记忆。

**2. 模型是你的一行私产。** ZCode 的子代理注册是静态的，跑起来换不了模型，所以这一版把模型完全交给你：所有壳默认 `model: inherit`，跟着会话默认模型走；想钉死哪档，就在那档的 frontmatter 里改一行 `model:`，或者用 `/switchman-setup` 对话式完成。插件从不检查、也从不评判你绑了什么。

在此之上：

- **派发有纪律**。每个壳的委派必须带一行 `ROUTE_META` 元数据，门禁做确定性校验：读写错配、看图任务派错壳，一律拦下并告诉你该派给谁；连续失败自动熔断，到点自愈。
- **发布即脱敏**。仓库里只有通用模板和代码，任何真实的服务商、套餐、模型绑定、配额口径都不入库——你的绑定只存在于你的家目录。

## 和 opencode-switchman 的差异

同源同作者，六档编队、ROUTE_META 派发协议、同伴技能都是同一套。差异来自宿主：OpenCode 插件跑在宿主进程里，平台给得多；ZCode 插件是声明式组件加独立进程 hook，给不了的就砍掉。

| | [opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 版） | 本仓库（ZCode 版） |
|---|---|---|
| 壳矩阵 | 动态，发现模型就生成壳，运行时可换 | 固定六档，壳名不变 |
| 模型调度 | 自动：加权评分、配额感知、探测、高峰避让 | 手动：每壳一行 `model:`，你说了算 |
| 上下文水位控制 | 有：实测水位、读类闸门、软硬水位、自动备份压缩 | 没有 |
| 会话交接 | 全自动：fork 备份、压缩、无缝续作 | 命令引导：写好交接文档，你按一次 `/compact`，hook 注入文档全文自动续作；fork 由你在客户端菜单自行决定 |
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
2. **（可选）钉模型。** 默认 `model: inherit` 已经够用；想让某档跑固定模型，跑 `/switchman-setup` 对话式改绑，或手改 `~/.zcode/agents/switchman-<档位>.md` 的 `model:` 行。壳文件在会话启动时快照，改完要重开会话才生效。
3. **正常干活。** 不用记任何新命令：主模型按 `switchman-routing` 技能挑档派发（每轮 `[ROUTE]` token 账铁律兜底），你也可以直接说「这活派给 hard」。每次委派自带 ROUTE_META，门禁自动把关。
4. **心里没底就体检。** `/switchman-doctor`，七项自检。
5. **会话跑长了就交接。** `/switchman-handover` 把当前会话总结成 `.switchman/` 下的交接文档并留下指针，你按一次 `/compact`，SessionStart hook 把文档全文注入新上下文，从 Next steps 无缝接着干。（超过 16KB 的文档降级为指针行；fork 备份由你在客户端会话菜单自行操作。）

state 目录默认 `~/.zcode/state/`（可用 `ZCODE_SWITCHMAN_STATE` 覆盖），存熔断状态 `routing.json` 和失败记录 `failures.log`。本插件的命令在 `/` 菜单里显示为 `$switchman-setup` 这样的形式，是同一批命令。

## 核心功能

**核心**

- **自装配编队**——SessionStart hook 在每次会话启动时把六壳装配进 `~/.zcode/agents/`：缺失的从模板创建，过期的正文同步到当前模板（插件升级零操作生效）。`model:` 行归你，壳正文归模板，同步永不覆盖你的模型行。
- **派发门禁与熔断**——PreToolUse hook 给每次壳派发过三闸：失败熔断 → ROUTE_META 校验 → 语义闸（rw 的活不能派给只读壳，看图只能派 vision）。10 分钟内失败 2 次熔断该壳 10 分钟；not-found 类错误只熔断被请求的名字，拼错壳名不牵连健康壳。非 switchman 代理原样放行；门禁自身坏了 fail-open，绝不挡活。

**辅助**

- **会话横幅**——每次启动注入 `[Session] / [Shells] / [Binding] / [Sync] / [Breaker] / [Workspace] / [Rule]`；装配有变动才出现 `[Sync]`，有待交接时多一行一次性的 `[Handover]`。
- **项目语言偏好**——每个项目记住自己的对话/注释/文档语言。没配置过的项目，在改动任何东西之前模型必须先回答三道 `switchman-lang` 问题，期间改文件和派发都被门禁拦着；答案落盘 `<project>/.switchman/settings.json`，之后 `[LANG]` 铁律每轮重注入。你临时提的语言要求只对当轮生效。
- **派发优先纪律（token 账）**——每轮注入 `[ROUTE]` 铁律：动手前先用一句话权衡自己做还是派出去（自己做花主上下文且持续膨胀、压缩丢细节；派发花一个全新壳上下文，主上下文只付委派单和结论），并把当前上下文长度纳入考虑——越长越倾向派发；琐事（单行修改、看一两个已知文件、`.switchman/` 记账、协调编队）留给自己。开场横幅同步加 `[Rule]` 行。`.switchman/settings.json` 顶层 `"dispatch": "off"` 可关。
- **项目工作区 `.switchman/`**——壳的落盘输出、scratch 分析、交接文档统一放项目根的 `.switchman/`，不散落源码目录。建议加进项目的 `.gitignore`。
- **四条命令**——`/switchman-setup` 钉模型、`/switchman-doctor` 体检、`/switchman-handover` 交接、`/switchman-lang` 重设语言偏好。
- **四个技能**——`switchman-routing`（派发协议），以及自源项目原样平移的三个同伴：`git-commit-message`（只产出提交文案，绝不执行 git）、`requirement-docs`（需求/PRD/设计文档规范）、`db-query`（内置脚本只读核验 MySQL/Redis，拒绝一切写操作）。

## 文档

- 派发协议（六档怎么挑、ROUTE_META 怎么写）：[skills/switchman-routing/SKILL.md](./skills/switchman-routing/SKILL.md)
- 委派 prompt 模板（DELEGATION_V1）：[assets/delegation-template.md](./assets/delegation-template.md)
- 移植设计文档（平台差异、取舍、目标结构）：[docs/porting-handover.md](./docs/porting-handover.md)

## 仓库结构与契约

```
templates/agents/   六壳正本，会话启动自动装配到 ~/.zcode/agents
src/lib/            共享核心：shells / meta / breaker / provision / handover / lang / state /
                    route（dispatch 模式解析，settings.json 顶层开关可关，fail-open；
                    [ROUTE]/[Rule] 两行铁律文案唯一渲染出处：renderRouteLine / renderRuleLine）
hooks/              SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · PostToolUseFailure
commands/           setup · doctor · handover · lang
skills/             switchman-routing + git-commit-message / requirement-docs / db-query
test/               契约测试（node --test test/*.test.mjs）
```

改代码前扫一眼这几条，都有测试锁定：

1. 壳名 `switchman-<档位>` 是稳定标识，小版本绝不改。
2. ROUTE_META 行：键白名单、值小写、前 4000 字符内解析；`role` / `capability` / `source` 必填，未知键忽略。
3. `model:` 行归用户，壳正文归模板，装配同步不碰模型行。
4. deny 必附言：每次拦截都说明该改派哪个档位。
5. 门禁处处 fail-open：坏了写 stderr、放行，不挡活。
6. `.switchman/handover.json` 指针由 `/switchman-handover` 写入，SessionStart hook 一次性消费。

## 计划与展望

- [ ] 逐壳 userConfig 开关（state 目录、模板目录）
- [ ] 派发记账（每条派发的档位、耗时、结果）
- [ ] 探测矩阵集成（可选，需显式开启）
- [ ] 完整版路由器：把源项目的评分调度作为可选「进阶模式」搬过来
- [ ] 无视觉主模型的图像中继

有想法欢迎开 issue。

## 为爱发电

和 opencode-switchman 同源同作者。如果这套东西帮到了你，请作者喝杯咖啡的二维码在源仓库的[为爱发电](https://github.com/mrzturn/opencode-switchman/blob/main/README.zh.md#为爱发电)一节。

## License

MIT，见 [LICENSE](LICENSE)。
