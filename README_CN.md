# zcode-switchman

ZCode 插件：把多模型子代理派发变成确定性的、策略驱动的路由——
[opencode-switchman](https://github.com/mrzturn/opencode-switchman)
六档壳矩阵设计在 ZCode 上的移植实现。

**核心思想（换壳不换脑）**：子代理**壳**（`<池>-mx-<模型>-<档位>`）只绑定
*模型 × 思考档位 × 工具白名单*，角色由每次委派 prompt 动态赋予。一组 hooks
加一个 MCP server 负责按六档链路派发、对每个壳派发执行 `ROUTE_META` 契约
校验、连续失败触发熔断、并感知池配额。

> **发布即脱敏**——本仓库只包含通用引擎与占位示例配置。任何个人部署的
> 真实服务商、套餐、模型绑定、配额口径都不入库；一切部署相关内容都在
> 本地 `config/matrix.json`（已 gitignore）与 state 目录中。

## 功能

- **六档壳矩阵**——`economy / mechanical / main / hard / vision / review`
  候选链，由配置与运行时壳清单（registry）实时计算。
- **派发门禁**（PreToolUse hook）——每个壳派发过六闸：
  registry 状态 → 探测矩阵 → 熔断 → 池耗尽 → `ROUTE_META` 校验 →
  语义校验（复审异族、ro/rw、模态、付费池链尾）；deny 附言带实时重算的
  首候选，可直接改派。
- **ROUTE_META 契约**——每个壳委派 prompt 必带一行元数据：
  `ROUTE_META {"lane":"main","role":"programmer","producer_family":"alpha","capability":"rw","modality":"text","source":"auto"}`
- **熔断自愈**（PostToolUseFailure hook）——10 分钟窗口内失败 2 次触发
  10 分钟自动恢复的熔断；not-found 类错误只熔断请求名本身，拼错名不会
  牵连健康壳。
- **会话横幅**（SessionStart hook）——会话启动注入
  `[Route] / [Quota] / [Limits]` 三行上下文。
- **路由 MCP server**——`route_query`、`registry_list`、`breaker_status`。
- **CLI**——`scripts/route-cli.mjs`（确定性 JSON 输出）与
  `scripts/gen-shells.mjs`（由配置生成 `agents/*.md` 与 registry）。
- **命令与技能**——`/setup`（对话式首配，含模型自动发现）、`/handover`、
  `/doctor` 与 `switchman-routing` 派发协议技能。

## 快速开始

**前置要求**：`PATH` 上有 Node.js ≥ 18。插件的 hooks 与 MCP server 以 `node`
子进程运行（与官方 ZCode 插件模板一致）；没有 node 时按 fail-open 静默失效
——`/doctor` 的第一项就是检查这个。

```bash
# 1. 安装插件（marketplace，或让 ZCode 指向本目录）

# 2. 生成壳矩阵——二选一：
#    a) 对话式配置（自动发现 ZCode 可用模型，问答式建池/排档，代写 config/matrix.json）：
/zcode-switchman:setup
#
#    b) 手动：
cp config/matrix.example.json config/matrix.json
$EDITOR config/matrix.json     # 填入池、模型绑定、六档链

# 3. 生成 agent 壳与 registry
node scripts/gen-shells.mjs

# 4. 重启 ZCode——新会话应出现路由横幅
```

state 目录默认 `~/.zcode/state/`（可用 `ZCODE_SWITCHMAN_STATE` 覆盖）。

### 验证

```bash
node scripts/route-cli.mjs --all          # 六档链 JSON
node scripts/gen-shells.mjs --check       # 配置 ↔ registry 漂移检查
node --test "test/*.test.mjs"             # 契约测试
```

## 配置（`config/matrix.json`）

| 键 | 含义 |
|---|---|
| `pools` | 命名服务商池。`paid: true` 标记按量付费池（`source=auto` 时仅链尾兜底）。`quotaFile` 指向 state 目录下的缓存文件：`{"status":"ok","fetched_at":<ts>,"scopes":{"<口径>":{"used_pct":0-100}}}`。 |
| `families` | 合法的 `producer_family` 值（真实模型 family——**不是**池名）。 |
| `shells` | 壳定义：`name`（`<池>-mx-<模型>-<档位>`）、`pool`、`family`、`model`、`thoughtLevel`、`capability`（`ro`/`rw`）、`modalities`。 |
| `lanes` | 档位 → 有序壳名。顺序即质量分层偏好；付费池在运行时强制链尾。 |
| `roleRouting` | 角色 → 池降级链（供文档/工具参考；运行时以 lanes 为准）。 |

配额缓存文件由你自己的刷新脚本写入（插件 hook 内绝不联网）。任一口径
用到 100% 即硬拦截——这是唯一的配额闸；80% 以上只缩短缓存 TTL。

## 架构

```
config/matrix.json      ← 你的私有壳矩阵（gitignore）
src/lib/*.mjs           ← 共享核心：config / meta / lane / quota / breaker / state
hooks/                  ← SessionStart / PreToolUse(Agent|Task) / PostToolUseFailure
mcp/routing-server.mjs  ← route_query / registry_list / breaker_status
scripts/                ← gen-shells.mjs、route-cli.mjs
agents/                 ← 生成的壳（gitignore——含个人模型绑定）
test/                   ← 契约测试（meta fixtures、lane 六闸、breaker）
```

沿袭源项目的设计规则：

- **处处 fail-open**——路由器坏了绝不阻塞干活；降级模式打标
  （`status: "ok*"`）并写 stderr。
- **单一实现源**——hooks、MCP、CLI 都调用 `src/lib/lane.mjs`，
  链路在不同入口间永不漂移。
- **hook 保持轻量**——只做本地 JSON 读取，3 秒预算内绰绰有余；
  重活交给刷新脚本 / MCP。

## 契约（勿随意破坏）

1. **ROUTE_META 行**——六个白名单键、值小写、解析前 4000 字符；
   `role` / `capability` / `source` 为必填安全字段。行为由
   `test/meta.test.mjs` 锁定。
2. **state 文件**——`shell-registry.json`（运行时壳权威）、
   `routing.json`（`down_agents` + `down_expiry`）、`route-state.json`
   （横幅快照）、`failures.log`（JSONL）、`<池>-quota.json`（配额缓存）。
3. **deny 附言**——每次拒绝都携带该档实时首候选，主模型无需重算即可改派。

## 路线图

- [ ] 探测集成（`urgency=immediate` 按延迟矩阵换序）
- [ ] 水位感知的链内换序（池 surplus/strained 状态）
- [ ] 会话水位计量门禁（软/硬预算）
- [ ] 无视觉主模型的图像中继
- [ ] `/poolConfig`、`/modelRank` 配置命令

## 许可

MIT——见 [LICENSE](LICENSE)。
