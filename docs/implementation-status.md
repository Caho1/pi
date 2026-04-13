# 与 PLAN.md 的实现对照

更新时间：2026-04-14

## 已完成

- 核心领域模型、策略对象与结果模型已落地：
  - `TaskEnvelope`
  - `AgentSourceSpec`
  - `CompiledAgentSpec`
  - `RunResult`
  - policy / artifact / platform error / task record
- 控制面最小闭环已完成：
  - 幂等去重
  - `AgentRegistry`
  - `SpecCompiler`
  - `TaskRouter`
  - `sync` / `async` 执行路径
  - 取消、重试、回调、artifact 查询、trace 查询
- 执行面核心链路已完成：
  - `PiResourceAssembler`
  - `DefaultPiExecutor`
  - `RunSettledBarrier`
  - `EventTranslator`
  - `AbortGraph`
  - artifact / trace 落盘
  - `submit_result` 结构化结果协议
- Provider 与运行治理已完成：
  - `right-codes` OpenAI-compatible provider 注册
  - `Provider failover`
  - `CompatibilityMatrix`
  - `ExtensionGovernance.hashPinned`
  - `safeguard compaction`
- Session 与任务编排已完成：
  - `SessionReusePolicy(within-task / within-thread)`
  - `SubagentRuntime(chain / parallel / dag-lite)` 最小可用实现
  - subagent started / finished / settled 事件翻译与等待
- Resource 装配治理已完成：
  - `CustomResourceLoader` 最小可用实现
  - 租户资源视图 `resource-views/<tenant>/view.json`
  - 运行时 `resourceOverrides`
  - 自定义 `systemPrompt / appendSystemPrompts / agentsFiles / skillRefs / extensionRefs / promptTemplateRefs`
- Workspace 能力已完成：
  - `readonly`
  - `ephemeral`
  - `git-worktree`
  - `container` 本地沙箱版
- 队列与恢复已完成：
  - 文件系统持久化队列
  - lease 恢复
  - 独立 worker runner
  - task DLQ
- 平台治理能力已完成：
  - 高风险任务审批 gating
  - callback 安全域名 allowlist
  - 多租户 runtime 路径净化与目录边界保护
  - Spec 版本管理与回滚 API
- 可观测性与审计已完成最小闭环：
  - 审计日志 `runtime/audit/audit.jsonl`
  - `/metrics`
  - SLA / 成本看板 API
  - compaction / retry / failover / token / cost / subagent 指标汇总
- RPC worker 最小模式已完成：
  - JSONL over stdio 协议客户端
  - round-robin `RpcTaskProcessorPool`
  - worker 侧 `RpcTaskProcessorServer`
  - `pnpm worker:rpc` 启动入口

## 当前已提供的控制面 API

- `POST /v1/agent-tasks`
- `GET /v1/agent-tasks/{taskId}`
- `POST /v1/agent-tasks/{taskId}/cancel`
- `POST /v1/agent-tasks/{taskId}/retry`
- `GET /v1/agent-tasks/{taskId}/artifacts`
- `GET /v1/agent-runs/{runId}/trace`
- `GET /metrics`
- `GET /v1/dashboard/overview`
- `GET /v1/dashboard/tenants/{tenantId}`
- `GET /v1/agent-specs/{agentType}/versions`
- `POST /v1/agent-specs/{agentType}/rollback`

## 仍需硬化的点

- `container` 当前是本地沙箱工作区实现：
  - 已有仓库快照复制、只读 `input`、清单落盘、清理解冻与回收
  - 尚未接入真正的 OCI runtime / cgroup / namespace / 挂载白名单，因此不是强容器隔离
- RPC worker 集群当前是“可用最小版”：
  - 已支持跨进程 JSONL 调用与本地 round-robin worker 池
  - 尚未补服务发现、自动扩缩容、远程节点注册、心跳摘除
- 可观测性当前是“平台内建最小版”：
  - 已有指标聚合、审计日志与 SLA / 成本看板
  - 尚未接入外部 tracing backend / OTLP / 告警平台
- 外部生产队列仍未接入 Redis / BullMQ 等专用基础设施，当前以文件系统队列为主

## 本轮新增验证

- `audit log + metrics` 聚合测试已补齐。
- SLA / 成本看板 API 聚合测试已补齐。
- Spec 版本列表与回滚测试已补齐。
- RPC worker round-robin 池化测试已补齐。
- callback 安全域名 allowlist 测试已补齐。
- 多租户路径净化与 session 边界测试已补齐。
- 兼容矩阵回归套件版本与扩展摘要校验测试已补齐。

## 当前证据

- 自动化验证以最终一轮为准：
  - `pnpm test`
  - `pnpm check`
  - `pnpm build`
- 真实 `right-codes` smoke 能力已具备：
  - `requirement.analysis` 能成功完成
  - `submit_result` 结构化输出可落盘
  - artifact 可归档
  - trace 可持久化
