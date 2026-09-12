# zcode-switchman

ZCode 插件：给你一支**固定六档子代理编队**——六类职责壳，一档一壳，壳背后的
模型由你自己用一行 frontmatter 绑定。壳名永不改变——换模型不动任何 prompt、
文档与肌肉记忆。

[opencode-switchman](https://github.com/mrzturn/opencode-switchman)
的移植简化版：ZCode 的子代理注册是静态的、不支持运行时换模型，所以编队固定、
**模型绑定交给用户**——手动改 `~/.zcode/agents`，或用 `/switchman-setup`
对话式完成。

> **发布即脱敏**——本仓库只包含通用模板与代码。任何个人部署的真实服务商、
> 套餐、模型绑定、配额口径都不入库；你的绑定只存在于你的家目录。

## 编队

| 档位 | 壳 | 读写 | 档深 | 用途 |
|---|---|---|---|---|
| economy | `switchman-economy` | ro | low | 海量轻量检索/摘要/清点 |
| mechanical | `switchman-mechanical` | rw | low | 格式化/搬运/数据杂活 |
| main | `switchman-main` | rw | medium | 日常实现主力 |
| hard | `switchman-hard` | rw | high | 深度设计/难题攻坚 |
| vision | `switchman-vision` | ro（image） | medium | 看图/截图驱动的工作 |
| review | `switchman-review` | ro | high | 只评审的第二双眼睛 |

- 壳只绑定 *职责类别 × 工具白名单 × 思考档位*；角色由每次委派 prompt
  动态赋予（DELEGATION_V1）。
- 壳**未绑定模型**时跟随会话默认模型——零配置即可用；绑了模型才有真正的
  多模型分工。插件从不检查、从不评判模型：你绑什么（或继承什么）就跑什么。

## 功能

- **六个固定壳**——以模板随插件分发，安装到 `~/.zcode/agents/`（在
  Settings → Subagents 里与其他子代理一样可见）。
- **绑定模型 = 一行**——壳 frontmatter 里的 `model: "..."`，或
  `model: inherit` 表示跟随默认模型；`/switchman-setup` 替你写入（默认
  提议 `inherit`），选钉死模型时才用 `scripts/discover-models.mjs` 发现
  你的 ZCode 模型（绝不读取/打印 API key）。
- **派发门禁**（PreToolUse hook）——每个壳派发过三闸：失败熔断 →
  `ROUTE_META` 校验 → 语义（rw 任务不能派给只读壳、image 任务只能派给
  视觉壳）。非 switchman 代理原样放行。
- **ROUTE_META 契约**——每个壳委派 prompt 必带一行元数据：
  `ROUTE_META {"lane":"main","role":"programmer","capability":"rw","modality":"text","source":"auto"}`
- **熔断自愈**（PostToolUseFailure hook）——10 分钟窗口内失败 2 次触发该壳
  10 分钟自动恢复的熔断；not-found 类错误只熔断请求名本身，拼错名不会
  牵连健康壳。
- **会话横幅**（SessionStart hook）——每次会话启动注入
  `[Session] / [Shells] / [Binding] / [Breaker] / [Workspace]` 五行上下文
  （有待交接时再多一行一次性的 `[Handover]`）。
- **项目工作区 `.switchman/`**——所有中间产物（壳的落盘输出、scratch
  分析、交接文档）统一放项目根的 `.switchman/`，绝不散落源码目录；该规则
  由横幅、routing 技能、壳模板与委派模板四处共同承载。
- **命令与技能**——`/switchman-setup`（对话式首配绑模型）、`/switchman-doctor`、
  `/switchman-handover`（总结→交接文档→fork 备份→compact→续作）与
  `switchman-routing` 派发协议技能。

## 快速开始

**前置要求**：`PATH` 上有 Node.js ≥ 18。插件 hooks 以 `node` 子进程运行
（与官方 ZCode 插件模板一致）；没有 node 时按 fail-open 静默失效——
`/switchman-doctor` 的第一项就是检查这个。

```bash
# 1. 安装插件（marketplace，或让 ZCode 指向本目录）

# 2. 安装壳并绑定模型——二选一：
#    a) 对话式（自动发现 ZCode 可用模型，逐档询问，代写文件）：
/switchman-setup
#
#    b) 手动：
mkdir -p ~/.zcode/agents
cp <插件目录>/templates/agents/switchman-*.md ~/.zcode/agents/
$EDITOR ~/.zcode/agents/switchman-main.md   # 加一行：  model: "你的模型ID"
                                            # 或：      model: inherit

# 3. 开一个新 ZCode 会话——启动时会出现横幅
```

state 目录默认 `~/.zcode/state/`（可用 `ZCODE_SWITCHMAN_STATE` 覆盖）；
存放 `routing.json`（熔断）与 `failures.log`。

派发级实装验收得出的三条结论：

- **壳文件在会话启动时快照**——改 `~/.zcode/agents/` 里的 `model:`
  （或 tools/description）**不会**热生效；需重开一个 ZCode 会话才加载。
- **未绑定的壳跟随会话默认模型。** 要查某次派发实际跑在哪个模型上，读
  ZCode 日志（`~/.zcode/cli/log/zcode-<日期>.jsonl`），找带
  `"querySource":"subagent"` 的事件——其 `model` 字段是权威记录。
- **命令显示形式**：本插件命令在客户端 `/` 菜单里显示为
  `$switchman-setup`（`$` 前缀 + 文件名，不带插件名前缀，不存在双重
  前缀问题）。

## 工作区与交接

所有 switchman 中间产物统一放**项目根的 `.switchman/`** 目录——壳的落盘
输出、scratch 分析、提取的数据、交接文档。`rw` 壳在委派 prompt 里拿到明确
的产物路径（缺省 `.switchman/`）；`ro` 壳不落盘——产物以文本返回，由委派方
落盘。除非想给交接文档做版本管理，建议把 `.switchman/` 加进项目的
`.gitignore`。

`/switchman-handover` 把当前会话交接给新上下文：

1. 把会话总结写进
   `.switchman/<日期>/<会话 ID>/handover/handover.md`（固定章节；
   「Next steps」是续作起点）。
2. 写指针 `.switchman/handover.json`——SessionStart hook 在下一次会话启动
   （含 compact）时注入 `[Handover] pending:` 行并清除该文件（一次性）。
3. Fork 当前会话作为 compact 前的备份（客户端会话列表，或支持的 CLI；
   即使不 fork，转录 `~/.zcode/cli/rollout/model-io-<会话 ID>.jsonl` 也不
   会因 compact 丢失）。
4. 执行 `/compact`——新上下文会从 `[Handover]` 行拿到文档路径，读取文档并
   从 Next steps 继续。

### 验证

```bash
/switchman-doctor                # ZCode 内：7 项自检
node --test "test/*.test.mjs"    # 契约测试
```

## 架构

```
templates/agents/       ← 六壳正本（随插件分发；拷贝到 ~/.zcode/agents）
src/lib/*.mjs           ← 共享核心：shells（编队表）/ meta / breaker / handover / state
hooks/                  ← SessionStart / PreToolUse(Agent|Task) / PostToolUseFailure
scripts/discover-models.mjs ← 枚举 ZCode 已配置模型（供 /switchman-setup）
commands/               ← /switchman-setup · /switchman-doctor · /switchman-handover
skills/switchman-routing/   ← 派发协议（六档、ROUTE_META、失败处理）
assets/delegation-template.md ← DELEGATION_V1 委派 prompt 模板
test/                   ← 契约测试（meta fixtures、编队、hook 冒烟）
```

沿袭源项目的设计规则：

- **处处 fail-open**——门禁坏了绝不阻塞干活；错误写 stderr，派发照常放行。
- **单一实现源**——hooks 都调用 `src/lib/*`，门禁语义在不同入口间永不漂移。
- **hook 保持轻量**——只读本地文件、不联网，3 秒预算内绰绰有余。

## 契约（勿随意破坏）

1. **ROUTE_META 行**——五个白名单键、值小写、解析前 4000 字符；
   `role` / `capability` / `source` 为必填安全字段；未知键直接忽略。
   行为由 `test/meta.test.mjs` 锁定。
2. **壳名**——`switchman-<档位>` 是稳定标识符：委派 prompt、文档、deny
   附言、横幅都引用它。小版本绝不改壳名。
3. **state 文件**——`routing.json`（`down_agents` + `down_expiry`）、
   `failures.log`（JSONL），以及项目级 `.switchman/handover.json` 指针
   （由 `/switchman-handover` 写入、SessionStart hook 一次性消费）。
4. **deny 附言**——每次拒绝都说明应改用哪个档位/壳。

## 路线图

- [ ] userConfig 逐壳开关（state 目录、模板目录）
- [ ] 派发记账（PostToolUse 台账：档位、耗时、结果）
- [ ] 探测矩阵集成（可选、需显式开启）
- [ ] 多池档位链——完整版 opencode-switchman 路由器作为可选「进阶模式」
- [ ] 无视觉主模型的图像中继

## 许可

MIT——见 [LICENSE](LICENSE)。
