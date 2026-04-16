# Pi Agent Platform

面向企业数字化系统的 Pi Agent 执行平台。

这个项目的目标不是做一个单纯的聊天机器人，而是把 Pi Agent 能力封装成一套可编排、可审计、可治理、可灰度发布的任务执行平台，供工单系统、流程引擎、审批系统、知识系统、代码系统统一接入。

当前实现已经具备“生产级最小闭环”能力：

- 控制面任务 API
- 一任务一会话执行模型
- `submit_result` 结构化结果协议
- artifact / trace / 审计日志落盘
- provider failover
- 高风险任务审批 gating
- session 复用
- subagent 最小运行时
- `git-worktree` / `container` 本地沙箱工作区
- SLA / 成本看板
- Spec 版本管理与回滚
- RPC worker 最小模式

更细的实现状态请看：

- [docs/implementation-status.md](./docs/implementation-status.md)
- [docs/expert-profile-api-simple.md](./docs/expert-profile-api-simple.md)
- [PLAN.md](./PLAN.md)

## 适用场景

这套平台适合下面这类集成方式：

- 工单系统发起“需求分析”“代码审查”“配置生成”等任务
- 流程引擎把某个节点委托给 Agent 自动执行
- 审批系统先给高风险任务审批，再放行执行
- 数字化系统统一管理业务状态，平台只负责执行、审计与产物归档

不建议把它当成：

- 业务主数据库
- 企业级全局调度系统
- 所有任务都长期挂载在一个主会话里的智能体

## 当前能力概览

### 控制面 API

已提供：

- `POST /v1/agent-tasks`
- `POST /v1/expert-profiles/extract`
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

### 内置 Agent

当前仓库内已提供这些内置 Agent：

- `reviewer`
  默认对应任务类型 `code.review`
- `requirement-analyst`
  默认对应任务类型 `requirement.analysis`
- `expert-profile`
  默认用于专家主页抽取场景，对外输入 URL 或本地 HTML，输出结构化专家数据

### 已实现的治理能力

- 幂等去重
- 审批 gating
- callback 重试 + DLQ
- callback 域名 allowlist
- 审计日志
- metrics
- SLA / 成本聚合看板
- 多租户运行时路径净化
- Compatibility Matrix
- Spec 版本回滚

## 项目结构

```text
apps/
  agent-control-plane/   控制面 HTTP API、回调、看板、Spec 治理、队列协调
  agent-worker/          执行面、Pi runtime 装配、workspace、trace、artifact、RPC worker

packages/
  agent-contracts/       领域模型、API 契约、运行结果模型
  agent-platform-shared/ 共享基础设施、SpecCompiler、Registry、Repository、配置
  agent-specs/agents/    Agent 规范定义（policy.json / soul.md / agent.md）

tests/                   回归测试
docs/                    状态文档
PLAN.md                  总体设计与实施计划
```

## 快速开始

### 1. 安装依赖

```bash
cd /Users/bystanders/Desktop/pi
pnpm install
```

### 2. 配置环境变量

最少需要提供模型提供方配置。

当前默认调度模型配置为阿里云百炼 `glm-5.1`：

```bash
export ALIYUN_BAILIAN_API_KEY='你的密钥'
export ALIYUN_BAILIAN_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1'
export ALIYUN_BAILIAN_MODEL_ID='glm-5.1'
export PORT=3000
```

可选配置：

```bash
export PLATFORM_CALLBACK_MAX_ATTEMPTS='3'
export PLATFORM_CALLBACK_BACKOFF_BASE_MS='250'
export PLATFORM_CALLBACK_BACKOFF_MAX_MS='2000'
export PLATFORM_CALLBACK_ALLOWED_DOMAINS='trusted.example.com,api.example.com'
```

### 3. 启动开发服务

```bash
pnpm dev
```

默认监听：

- `http://192.168.135.172:3000`

### 4. 生产构建启动

```bash
pnpm build
pnpm start
```

### 5. 启动独立 RPC worker

当前主启动方式默认是“控制面 + 内嵌 worker”。

如果你要测试 RPC worker 最小模式，可以单独启动：

```bash
pnpm worker:rpc
```

## 开发命令

```bash
pnpm test
pnpm check
pnpm build
pnpm dev
pnpm start
pnpm worker:rpc
```

## 第一次联通测试

先发一个低风险同步任务：

```bash
curl -X POST http://192.168.135.172:3000/v1/agent-tasks \
  -H 'content-type: application/json' \
  -d '{
    "idempotencyKey": "demo-1",
    "tenantId": "acme",
    "taskType": "code.review",
    "priority": "p1",
    "triggerType": "sync",
    "timeoutMs": 120000,
    "input": {
      "prompt": "请对这段示例代码做快速审查，并输出结构化结论"
    },
    "trace": {
      "correlationId": "corr-demo-1",
      "sourceSystem": "manual-test"
    }
  }'
```

如果成功，返回里会带：

- `taskId`
- `runId`
- `status`
- `runResult`
- `artifacts`

## Expert Profile 接入

`expert-profile` 是当前面向数字化系统接入的业务型 Agent，用来做「传入专家主页 URL，返回 18 个结构化字段」。
输出形态与数字化系统「专家主页同步」弹窗的勾选项一一对应，业务方拿到后可以直接填充弹窗右栏做左右对比同步。

当前实现状态：

- 外层调度模型使用阿里云百炼 `glm-5.1`，并关闭思考模式
- 内层专家抽取脚本使用阿里云百炼 `qwen3.6-plus`，启用 `json_object`
- `Web of Science` 作者页支持专用脚本路径，不走普通 HTML 抓取
- 同步模式下任务失败会尽快返回，不会一直阻塞等待
- 输出包含 15 个基础字段 + `social_positions`（社会兼职）/ `journal_resources`（期刊资源）/ `tags`（四分类枚举标签）

### 输入

最常见的输入是：

- 公开专家主页 URL
- `Web of Science` 作者页，例如 `https://www.webofscience.com/wos/author/record/917221`
- 本地 HTML 文件路径（用于离线测试或回放）

### 输出

`POST /v1/agent-tasks` 返回的是平台统一任务响应，不是纯业务 JSON。

如果你不希望业务系统理解平台任务协议，推荐直接使用新增的业务包装接口：

- `POST /v1/expert-profiles/extract`

对 `expert-profile` 来说，真正的专家数据位于：

- `result.structured`
- 同步模式下也会出现在 `runResult.result.structured`

### 推荐业务接口

```bash
curl -X POST http://192.168.135.172:3000/v1/expert-profiles/extract \
  -H 'Authorization: Bearer your-token' \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://www.webofscience.com/wos/author/record/917221",
    "requestId": "expert-profile-biz-1"
  }'
```

如果服务端配置了 `EXPERT_PROFILE_API_TOKEN`，调用时还需要带：

```text
Authorization: Bearer <token>
```

返回示例：

```json
{
  "success": true,
  "status": "SUCCEEDED",
  "requestId": "expert-profile-biz-1",
  "taskId": "task_xxx",
  "runId": "run_xxx",
  "promptTokens": 3500,
  "completionTokens": 420,
  "totalTokens": 3920,
  "data": {
    "name": "Anh Tuan Hoang",
    "institution": "Dong Nai Technol Univ",
    "research_areas": ["Energy & Fuels", "Engineering"],
    "social_positions": [],
    "journal_resources": [],
    "tags": {
      "academic_honors": [],
      "institution_tier": [],
      "experiences": [],
      "others": []
    }
  },
  "error": null
}
```

完整的字段说明、`tags` 枚举白名单与前端渲染建议见 [docs/expert-profile-api-simple.md](./docs/expert-profile-api-simple.md)。

### 专家抽取示例

```bash
curl -X POST http://192.168.135.172:3000/v1/agent-tasks \
  -H 'content-type: application/json' \
  -d '{
    "idempotencyKey": "expert-profile-demo-1",
    "tenantId": "digit-system",
    "taskType": "expert.profile.extract",
    "agentType": "expert-profile",
    "priority": "p1",
    "triggerType": "sync",
    "timeoutMs": 180000,
    "input": {
      "prompt": "https://www.webofscience.com/wos/author/record/917221",
      "metadata": {
        "approvalToken": "approved-by-upstream"
      }
    },
    "trace": {
      "correlationId": "corr-expert-profile-demo-1",
      "sourceSystem": "manual-test"
    }
  }'
```

示例响应中的关键字段：

```json
{
  "taskId": "task_xxx",
  "status": "SUCCEEDED",
  "result": {
    "structured": {
      "name": "Anh Tuan Hoang",
      "institution": "Dong Nai Technol Univ",
      "research_areas": ["Energy & Fuels", "Engineering"],
      "social_positions": [],
      "journal_resources": [],
      "tags": {
        "academic_honors": [],
        "institution_tier": [],
        "experiences": [],
        "others": []
      },
      "_meta": {
        "source_url": "https://www.webofscience.com/wos/author/record/917221",
        "extracted_at": "2026-04-14T08:00:00.000Z"
      }
    }
  },
  "runResult": {
    "usage": {
      "inputTokens": 3500,
      "outputTokens": 420,
      "provider": "aliyun-bailian",
      "model": "qwen3.6-plus"
    }
  }
}
```

### 对接注意事项

- `expert-profile` 默认需要联网和 `bash` 能力，因此通常会触发审批 gating；调用方需要在 `input.metadata.approvalToken` 里传非空值。
- 如果你只是给业务系统提供“传 URL，回专家数据”的能力，建议在平台前面再包一层业务接口，把 `result.structured` 解包后再返回给上游。
- 当前根接口支持 `sync / async / callback` 三种模式；如果一次要批量抽取很多专家主页，建议业务侧优先考虑异步模式。

## 核心请求结构

平台统一接收 `CreateTaskRequest`：

```json
{
  "idempotencyKey": "req-20260414-001",
  "tenantId": "acme",
  "taskType": "code.review",
  "agentType": "reviewer",
  "agentVersionSelector": "1.0.0",
  "priority": "p1",
  "triggerType": "sync",
  "timeoutMs": 600000,
  "callback": {
    "url": "https://trusted.example.com/agent-callback"
  },
  "input": {
    "prompt": "请审查这个 PR 的风险与改动质量",
    "structuredInput": {
      "ticketId": "PR-182"
    },
    "contextRefs": [
      {
        "artifactId": "patch-1",
        "kind": "diff",
        "uri": "file:///absolute/path/to/pr-182.diff"
      }
    ],
    "metadata": {
      "approvalToken": "approve-123"
    }
  },
  "constraints": {
    "allowWrite": false,
    "allowNetwork": false,
    "allowSubagents": false
  },
  "trace": {
    "correlationId": "corr-123",
    "parentTaskId": "workflow-node-9",
    "requester": "alice",
    "sourceSystem": "workflow-engine"
  }
}
```

### 重要字段说明

- `idempotencyKey`
  业务幂等键，建议用工单 ID、流程实例 ID、消息唯一键
- `tenantId`
  租户、客户或组织标识
- `taskType`
  业务任务类型
- `agentType`
  可选。指定后优先走这个 Agent，不再依赖默认路由
- `agentVersionSelector`
  可选。指定具体 Agent 版本
- `triggerType`
  `sync` / `async` / `callback`
- `contextRefs`
  当前最稳妥的方式是使用本地绝对路径或 `file://` 路径
- `constraints`
  用来限制写权限、网络、subagent、人工审批

## 返回结果模型

平台返回 `RunResult`，主要包含：

- `status`
  `succeeded` / `failed` / `cancelled` / `timed_out` / `partial`
- `result`
  最终业务输出
- `artifacts`
  产物索引
- `usage`
  provider / model / token / 成本信息
- `diagnostics`
  retry / failover / failure 诊断
- `timestamps`
  关键时间戳

如果 Agent 使用了 `submit_result`，则结构化业务结果会进入：

- `runResult.result.structured`

## 与数字化系统集成

推荐把你的数字化系统当作业务控制层，把这个项目当作 Agent 执行平台。

### 推荐映射

- `流程实例ID / 工单ID / 消息ID`
  -> `idempotencyKey`
- `租户 / 组织 / 客户`
  -> `tenantId`
- `流程链路ID`
  -> `trace.correlationId`
- `父流程节点`
  -> `trace.parentTaskId`
- `流程动作类型`
  -> `taskType`
- `是否需要人工审批`
  -> `constraints.requireHumanApproval`
- `审批结果 / 审批单号`
  -> `input.metadata.approvalToken`

### 推荐接入顺序

1. 先接 `POST /v1/agent-tasks` 和 `GET /v1/agent-tasks/{taskId}`
2. 再接 callback 回推
3. 再接 trace、metrics、dashboard
4. 最后接 Spec 版本回滚和更复杂的 Agent 治理

### callback 注意事项

如果配置了 `PLATFORM_CALLBACK_ALLOWED_DOMAINS`，只有白名单域名才允许接收回调，其他域名会被拒绝并写入 callback DLQ。

## Agent 配置

每个 Agent 都放在：

```text
packages/agent-specs/agents/<agent-name>/
```

典型内容包括：

- `policy.json`
- `soul.md`
- `agent.md`

### 如何新增一个 Agent

1. 新建目录 `packages/agent-specs/agents/<your-agent>/`
2. 编写 `policy.json`
3. 按需编写 `soul.md` 和 `agent.md`
4. 通过请求里的 `agentType` 显式调用它
5. 如果希望 `taskType` 自动路由到它，再修改默认 `TaskRouter`

## Skill 配置

当前 skill 采用“显式配置加载”模式，不依赖工作区自动发现。

### 给不同 Agent 配不同 skill

在各自的 `policy.json` 里写 `skillRefs`：

```json
{
  "agentType": "reviewer",
  "skillRefs": [
    "/absolute/path/to/review-skill/SKILL.md"
  ]
}
```

```json
{
  "agentType": "requirement-analyst",
  "skillRefs": [
    "/absolute/path/to/requirement-skill/SKILL.md"
  ]
}
```

### 调用时指定某个 Agent

请求里直接传：

```json
{
  "taskType": "code.review",
  "agentType": "reviewer"
}
```

如果不传 `agentType`，平台才会按默认路由根据 `taskType` 选择 Agent。

### 租户级 / 任务级临时注入 skill

还支持通过资源覆盖注入：

- `input.metadata.resourceView`
- `input.metadata.resourceOverrides.skillRefs`

适合做：

- 某个租户专用 skill
- 某次任务临时增加 skill
- 中文版 / 行业版 / 安全版 Agent 资源视图

## Workspace 模式

当前已支持：

- `readonly`
  只读任务
- `ephemeral`
  普通临时工作区
- `git-worktree`
  基于现有仓库生成独立 worktree
- `container`
  本地沙箱版工作区

### `git-worktree` 模式额外要求

如果使用 `git-worktree`，任务需要在 `input.metadata` 里提供：

- `repoPath`
- 可选 `branchName`

### `container` 模式说明

当前 `container` 还不是强隔离容器，只是本地沙箱工作区实现，已经有：

- 仓库快照复制
- `input/` 只读挂载
- `container-manifest.json`
- 清理解冻与回收

但还没有真正接 OCI runtime / cgroup / namespace。

## 审批与安全

平台会在这些情况触发人工审批要求：

- `constraints.requireHumanApproval === true`
- workspace 为 `container`
- 网络不是 `disabled`
- tool policy 含 `write` / `edit` / `bash`

如果没有审批证据，任务会直接被拒绝。

当前支持的审批证据字段：

- `input.metadata.approvalToken`
- `input.metadata.approvalApproved === true`
- `input.metadata.approval.approved === true`
- `input.metadata.approval.ticketId`

## 可观测性

### 指标

可通过：

- `GET /metrics`

查看平台内存指标快照。

### 看板

可通过：

- `GET /v1/dashboard/overview`
- `GET /v1/dashboard/tenants/{tenantId}`

查看：

- 任务总数
- 状态分布
- 平均时长
- 成本
- SLA breach
- 租户维度与 provider 维度聚合

### 审计日志

审计日志写入：

```text
runtime/audit/audit.jsonl
```

### Trace

trace 可通过：

- `GET /v1/agent-runs/{runId}/trace`

查看，也会作为 artifact 落盘。

## Spec 版本治理

平台已支持：

- 查询某个 Agent 的版本列表
- 切换当前激活版本
- 回滚到旧版本

对应接口：

- `GET /v1/agent-specs/{agentType}/versions`
- `POST /v1/agent-specs/{agentType}/rollback`

## RPC Worker

当前已提供最小可用 RPC 模式：

- 客户端：`RpcTaskProcessorClient`
- 简单 worker 池：`RpcTaskProcessorPool`
- worker 服务端：`RpcTaskProcessorServer`
- 启动命令：`pnpm worker:rpc`

当前适合：

- 本地验证
- 跨进程调用实验
- 为后续远程 worker 集群做协议基线

尚不适合直接当成完整生产级集群方案。

## 已知限制

- `contextRefs` 当前最稳的是本地绝对路径或 `file://`
- `container` 还不是强隔离容器
- 队列目前主要是文件系统实现，未接 Redis / BullMQ
- RPC worker 目前还是最小可用版本，未做远程注册发现与弹性伸缩
- skill 目前是显式配置加载，不是把 skill 丢进工作区就自动启用

## 回归验证

当前推荐的基础验证命令：

```bash
pnpm test
pnpm check
pnpm build
```

## 后续建议

如果你准备把这套平台真正接入数字化系统，建议下一步优先做：

1. 把你们现有的业务动作整理成标准 `taskType`
2. 给每类业务动作配置固定 Agent 与 skill
3. 把审批流、callback 域名和 `tenantId` 规则固定下来
4. 把 `contextRefs` 接成你们稳定的附件路径下发方式
5. 再决定是否需要引入外部队列、远程 RPC worker、强容器隔离
