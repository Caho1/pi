# API 接入文档

面向对接方的 HTTP API 文档。

本文档的目标读者是：

- 流程引擎接入方
- 工单系统接入方
- 中台 / 后台 / BFF 开发者
- 运维与测试同学

如果你想了解项目整体设计、目录结构和本地开发方式，请看：

- [README.md](./README.md)
- [docs/implementation-status.md](./docs/implementation-status.md)

## 1. 概述

本平台对外提供统一的 Agent 任务执行 API。

平台负责：

- 接收任务
- 做幂等去重
- 选择 Agent 与版本
- 执行任务
- 返回结构化结果
- 归档 artifacts / trace / audit

业务系统负责：

- 创建业务任务
- 决定 `taskType`
- 传入业务上下文
- 保存 `taskId / runId`
- 接收回调或轮询任务状态

## 2. Base URL

本地默认地址：

```text
http://127.0.0.1:3000
```

生产环境请替换为你的网关或服务域名。

## 3. 鉴权说明

当前项目代码里**没有内建 HTTP 鉴权层**。

推荐做法：

- 在上游网关做鉴权
- 在内网服务之间通过服务身份调用
- 由网关补充租户、调用方、限流和审计信息

## 4. 通用约定

### 4.1 请求格式

- `Content-Type: application/json`
- 所有请求体和响应体均为 UTF-8 JSON

### 4.2 幂等

创建任务时请始终传：

- `idempotencyKey`

平台会按以下组合做幂等：

- `tenantId`
- `taskType`
- `idempotencyKey`

如果是重复请求，平台不会重复执行任务，而是直接返回已存在的任务记录。

### 4.3 同步 / 异步 / 回调

通过 `triggerType` 控制执行模式：

- `sync`
  等待任务进入最终态后直接返回 `runResult`
- `async`
  立即返回 `taskId`，由调用方轮询查询状态
- `callback`
  立即返回 `taskId`，平台完成后回调外部地址

### 4.4 任务生命周期状态

平台任务状态包括：

- `RECEIVED`
- `DEDUPING`
- `REJECTED`
- `ROUTED`
- `PREPARING`
- `RUNNING`
- `SETTLING`
- `SUCCEEDED`
- `PARTIAL`
- `FAILED`
- `TIMED_OUT`
- `CANCELLING`
- `CANCELLED`

业务侧通常只需要重点关注：

- `REJECTED`
- `SUCCEEDED`
- `PARTIAL`
- `FAILED`
- `TIMED_OUT`
- `CANCELLED`

## 5. CreateTaskRequest 请求体

### 5.1 字段说明

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
  "deadlineAt": "2026-04-14T12:00:00.000Z",
  "callback": {
    "url": "https://trusted.example.com/agent-callback",
    "topic": "workflow.task.completed",
    "headers": {
      "x-request-id": "req-123"
    }
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
    "maxCostUsd": 3,
    "maxTokens": 12000,
    "allowWrite": false,
    "allowNetwork": false,
    "allowSubagents": false,
    "requireHumanApproval": false
  },
  "trace": {
    "correlationId": "corr-123",
    "parentTaskId": "workflow-node-9",
    "requester": "alice",
    "sourceSystem": "workflow-engine"
  }
}
```

### 5.2 关键字段解释

| 字段 | 必填 | 说明 |
|---|---|---|
| `idempotencyKey` | 是 | 业务幂等键。建议使用工单 ID、流程实例 ID 或消息唯一键 |
| `tenantId` | 是 | 租户 / 组织 / 客户标识 |
| `taskType` | 是 | 业务任务类型 |
| `agentType` | 否 | 显式指定 Agent。传了就优先使用，不再依赖默认路由 |
| `agentVersionSelector` | 否 | 显式指定 Agent 版本 |
| `priority` | 是 | `p0` / `p1` / `p2` / `p3` |
| `triggerType` | 是 | `sync` / `async` / `callback` |
| `timeoutMs` | 是 | 超时时间，毫秒 |
| `deadlineAt` | 否 | 绝对截止时间，ISO 8601 |
| `callback.url` | 否 | callback 模式下的回调地址 |
| `input.prompt` | 是 | 任务自然语言主输入 |
| `input.structuredInput` | 否 | 结构化业务输入 |
| `input.contextRefs` | 否 | 附件 / diff / 文档等上下文 |
| `input.metadata` | 否 | 任务扩展字段，如审批、repoPath、resourceView 等 |
| `constraints` | 否 | 运行时限制，如是否允许写、联网、subagent、成本上限 |
| `trace.correlationId` | 是 | 业务主链路 ID，建议始终与流程主键对齐 |

### 5.3 `contextRefs` 说明

当前版本最稳妥的上下文引用方式是：

- 本地绝对路径
- `file://` 绝对路径

例如：

```json
{
  "artifactId": "doc-1",
  "kind": "pdf",
  "uri": "file:///data/shared/specs/requirements.pdf"
}
```

说明：

- 当前版本不会自动帮你拉取 S3、OSS、HTTP 远程文件
- 如果你的附件在对象存储，建议由业务系统先下载到本地共享目录，再把本地路径传给平台

## 6. Agent 选择规则

### 6.1 默认路由

当前内置默认路由如下：

| `taskType` | 默认 `agentType` |
|---|---|
| `code.review` | `reviewer` |
| `requirement.analysis` | `requirement-analyst` |

### 6.2 显式指定 Agent

如果请求里传了 `agentType`，平台会直接使用你指定的 Agent。

示例：

```json
{
  "taskType": "code.review",
  "agentType": "reviewer"
}
```

### 6.3 显式指定 Agent 版本

如果你希望固定版本执行，可以传：

```json
{
  "agentType": "reviewer",
  "agentVersionSelector": "1.0.0"
}
```

如果不传版本，平台会使用当前激活版本。

## 7. Skill 配置说明

对接方最常见的需求是：

- 不同 Agent 绑定不同 skill
- 某个租户临时叠加 skill
- 某次任务临时增加 skill

当前平台支持这些能力，但采用的是**显式配置加载**，不是自动扫描工作区启用。

### 7.1 Agent 级 skill

通过 Agent 的 `policy.json` 中的 `skillRefs` 配置。

### 7.2 任务级 / 租户级临时注入

通过：

- `input.metadata.resourceView`
- `input.metadata.resourceOverrides.skillRefs`

适合做租户专属 skill 或某次任务的临时技能增强。

## 8. 审批与高风险任务

### 8.1 什么时候会触发审批要求

出现以下情况时，平台会要求人工审批：

- `constraints.requireHumanApproval === true`
- workspace 模式是 `container`
- 网络权限不是 `disabled`
- Agent 工具策略包含 `write` / `edit` / `bash`

### 8.2 如何提供审批证据

支持以下字段：

- `input.metadata.approvalToken`
- `input.metadata.approvalApproved === true`
- `input.metadata.approval.approved === true`
- `input.metadata.approval.ticketId`

### 8.3 未审批时的返回

平台会：

- 返回 `202`
- 任务状态为 `REJECTED`
- `error.code` 为 `approval.required`

业务系统应该把它当成“任务已受理但未获准执行”。

## 9. 主要接口

## 9.1 创建任务

### `POST /v1/agent-tasks`

创建一条 Agent 执行任务。

#### 同步任务成功示例

请求：

```bash
curl -X POST http://127.0.0.1:3000/v1/agent-tasks \
  -H 'content-type: application/json' \
  -d '{
    "idempotencyKey": "demo-sync-001",
    "tenantId": "acme",
    "taskType": "code.review",
    "priority": "p1",
    "triggerType": "sync",
    "timeoutMs": 120000,
    "input": {
      "prompt": "请对这段示例代码做快速审查，并输出结构化结论"
    },
    "trace": {
      "correlationId": "corr-demo-sync-001",
      "sourceSystem": "manual-test"
    }
  }'
```

返回：

- HTTP `200`
- body 中包含 `runResult`

响应示例：

```json
{
  "taskId": "task_xxx",
  "runId": "run_xxx",
  "status": "SUCCEEDED",
  "specId": "sha256:xxx",
  "taskType": "code.review",
  "agentType": "reviewer",
  "result": {
    "submissionMode": "submit_result",
    "structured": {
      "summary": "审查完成",
      "verdict": "comment",
      "findings": []
    }
  },
  "artifacts": [],
  "timestamps": {
    "createdAt": "2026-04-14T10:00:00.000Z",
    "updatedAt": "2026-04-14T10:00:10.000Z",
    "startedAt": "2026-04-14T10:00:01.000Z",
    "finishedAt": "2026-04-14T10:00:10.000Z"
  },
  "runResult": {
    "taskId": "task_xxx",
    "runId": "run_xxx",
    "specId": "sha256:xxx",
    "status": "succeeded",
    "completion": {
      "barrier": "settled-barrier",
      "promptResolved": true,
      "terminalEventSeen": true,
      "noPendingBackgroundWork": true,
      "finalizerPassed": true
    },
    "result": {
      "submissionMode": "submit_result",
      "structured": {
        "summary": "审查完成",
        "verdict": "comment",
        "findings": []
      }
    },
    "artifacts": []
  }
}
```

#### 异步任务成功示例

请求：

```json
{
  "idempotencyKey": "demo-async-001",
  "tenantId": "acme",
  "taskType": "requirement.analysis",
  "priority": "p1",
  "triggerType": "async",
  "timeoutMs": 120000,
  "input": {
    "prompt": "请分析这个需求并给出建议",
    "metadata": {
      "approvalToken": "approve-001"
    }
  },
  "trace": {
    "correlationId": "corr-demo-async-001"
  }
}
```

返回：

- HTTP `202`
- body 中不保证带 `runResult`
- 调用方应保存 `taskId` 后查询状态

#### 重复请求

如果同一 `tenantId + taskType + idempotencyKey` 已存在：

- 不会重复执行
- 返回 HTTP `202`
- 返回已有任务记录

#### 可能的响应状态码

| HTTP 状态码 | 含义 |
|---|---|
| `200` | 同步任务已完成，并返回最终结果 |
| `202` | 任务已受理，可能是异步执行、幂等命中或被审批 gating 拒绝 |

## 9.2 查询任务

### `GET /v1/agent-tasks/{taskId}`

根据 `taskId` 查询任务状态。

#### 成功响应

```json
{
  "taskId": "task_xxx",
  "runId": "run_xxx",
  "status": "RUNNING",
  "specId": "sha256:xxx",
  "taskType": "code.review",
  "agentType": "reviewer",
  "result": null,
  "artifacts": [],
  "error": null,
  "timestamps": {
    "createdAt": "2026-04-14T10:00:00.000Z",
    "updatedAt": "2026-04-14T10:00:05.000Z",
    "startedAt": "2026-04-14T10:00:01.000Z",
    "finishedAt": null
  }
}
```

#### 失败响应

```json
{
  "message": "Task not found"
}
```

状态码：

- `200`
- `404`

## 9.3 取消任务

### `POST /v1/agent-tasks/{taskId}/cancel`

尝试取消一个正在运行的任务。

成功响应：

```json
{
  "taskId": "task_xxx",
  "status": "CANCELLING"
}
```

状态码：

- `202`
- `404`

说明：

- 如果任务已不在运行中，可能返回 `404`
- 返回 `CANCELLING` 不代表已经完全取消，应继续轮询任务状态

## 9.4 重试任务

### `POST /v1/agent-tasks/{taskId}/retry`

把已有任务重新置回 `ROUTED` 并再次入队。

成功响应：

```json
{
  "taskId": "task_xxx",
  "status": "ROUTED"
}
```

状态码：

- `202`
- `404`

## 9.5 查询任务 artifacts

### `GET /v1/agent-tasks/{taskId}/artifacts`

返回任务已归档的 artifacts。

响应示例：

```json
{
  "taskId": "task_xxx",
  "artifacts": [
    {
      "artifactId": "artifact_1",
      "kind": "structured-result",
      "uri": "/absolute/path/to/result.json",
      "digest": "sha256:xxx",
      "title": "result.json",
      "sizeBytes": 1024
    }
  ]
}
```

## 9.6 查询运行 trace

### `GET /v1/agent-runs/{runId}/trace`

返回本次 run 的 NDJSON trace。

说明：

- `Content-Type` 为 `application/x-ndjson`
- 适合做排障、审计、回放

状态码：

- `200`
- `404`

## 9.7 查询 metrics

### `GET /metrics`

返回平台内存中的指标快照。

常见指标包括：

- `task_run_total`
- `task_run_succeeded_total`
- `task_run_failed_total`
- `task_run_duration_ms_total`
- `task_run_cost_usd_total`
- `task_run_compaction_total`
- `task_run_failover_total`
- `task_run_retry_total`
- `task_run_tokens_input_total`
- `task_run_tokens_output_total`
- `subagent_spawn_total`

## 9.8 查看平台看板

### `GET /v1/dashboard/overview`

查看平台整体聚合。

响应示例：

```json
{
  "generatedAt": "2026-04-14T10:00:00.000Z",
  "totals": {
    "tasks": 12,
    "costUsd": 4.3,
    "averageDurationMs": 5200,
    "slaBreaches": 1
  },
  "byStatus": {
    "SUCCEEDED": 10,
    "FAILED": 1,
    "TIMED_OUT": 1
  },
  "byTenant": [
    {
      "tenantId": "acme",
      "tasks": 9,
      "costUsd": 3.2
    }
  ],
  "byProvider": [
    {
      "provider": "right-codes",
      "model": "gpt-5-codex",
      "tasks": 12,
      "costUsd": 4.3
    }
  ]
}
```

### `GET /v1/dashboard/tenants/{tenantId}`

查看单租户维度聚合。

## 9.9 查询 Agent 版本

### `GET /v1/agent-specs/{agentType}/versions`

响应示例：

```json
{
  "agentType": "reviewer",
  "versions": ["1.0.0", "2.0.0"],
  "activeVersion": "2.0.0"
}
```

## 9.10 回滚 Agent 版本

### `POST /v1/agent-specs/{agentType}/rollback`

请求体：

```json
{
  "version": "1.0.0"
}
```

成功响应：

```json
{
  "agentType": "reviewer",
  "previousVersion": "2.0.0",
  "activeVersion": "1.0.0",
  "versions": ["1.0.0", "2.0.0"]
}
```

状态码：

- `200`
- `400`
- `404`

## 10. Callback 协议

如果创建任务时传了：

```json
{
  "callback": {
    "url": "https://trusted.example.com/agent-callback"
  }
}
```

任务完成后平台会发送：

```json
{
  "eventType": "task.completed",
  "taskId": "task_xxx",
  "runId": "run_xxx",
  "specId": "sha256:xxx",
  "status": "succeeded",
  "result": {
    "submissionMode": "submit_result",
    "structured": {
      "summary": "done"
    }
  },
  "artifacts": []
}
```

说明：

- callback 失败时平台会自动重试
- 重试耗尽后会写入 callback DLQ
- 如果配置了域名白名单，不在白名单里的 callback 会被直接拒绝

## 11. 错误语义

### 11.1 平台错误结构

任务失败时，常见字段：

```json
{
  "error": {
    "stage": "platform",
    "code": "run.timeout",
    "message": "timeout",
    "retryable": false
  }
}
```

### 11.2 常见错误码

| 错误码 | 说明 |
|---|---|
| `approval.required` | 高风险任务需要审批 |
| `resource_loader.view_not_found` | 指定的租户资源视图不存在 |
| `workspace.git_worktree_repo_missing` | `git-worktree` 模式未提供 `repoPath` |
| `model.not_found` | 未找到可用模型 |
| `compatibility.unsupported` | spec 与当前兼容矩阵不匹配 |
| `run.timeout` | 任务超时 |

### 11.3 关于字段缺失

当前版本对请求字段做了必要校验，但没有统一的业务错误包装中间件。

因此接入时请确保：

- 必填字段完整
- JSON 结构合法
- `trace.correlationId` 始终存在

## 12. 对接最佳实践

### 12.1 建议的幂等键策略

建议：

```text
idempotencyKey = <业务主键>:<动作类型>:<重试序号或版本号>
```

例如：

```text
WF-20260414-001:code-review:v1
```

### 12.2 建议的轮询策略

异步任务建议：

- 首次轮询延迟 1 秒
- 之后每 2~5 秒轮询一次
- 命中最终态后停止轮询

### 12.3 建议优先使用同步的场景

- 预计几十秒内能完成的纯分析任务
- 页面内即时等待结果的低成本任务

### 12.4 建议优先使用异步 / callback 的场景

- 需要代码读取或更长上下文的任务
- 可能有审批、重试、failover 的任务
- 流程引擎节点执行
- 批量任务

### 12.5 建议的业务字段映射

| 业务字段 | 平台字段 |
|---|---|
| 流程实例 ID | `idempotencyKey` |
| 租户 ID | `tenantId` |
| 流程主链路 ID | `trace.correlationId` |
| 父任务 / 父节点 ID | `trace.parentTaskId` |
| 审批单号 | `input.metadata.approvalToken` |
| 文档 / 附件 / diff | `input.contextRefs` |

## 13. 当前实现边界

对接前请知晓以下边界：

- 当前平台没有内建 HTTP 鉴权，请走网关
- `contextRefs` 目前不直接拉远程对象存储
- `container` 是本地沙箱工作区，不是强 OCI 隔离
- 队列当前以文件系统实现为主，不是 Redis / BullMQ
- RPC worker 目前是最小可用版，不是完整生产集群
- skill 目前是显式配置加载，不是自动发现启用

## 14. 推荐联调顺序

1. 先联通 `POST /v1/agent-tasks`
2. 再联通 `GET /v1/agent-tasks/{taskId}`
3. 再联调 callback
4. 再接 `trace`、`metrics`、`dashboard`
5. 最后再引入 Agent 版本治理、租户资源视图和更复杂的 skill 配置

## 15. 附录：最小对接示例

### 同步示例

```bash
curl -X POST http://127.0.0.1:3000/v1/agent-tasks \
  -H 'content-type: application/json' \
  -d '{
    "idempotencyKey": "WF-1001:review:v1",
    "tenantId": "acme",
    "taskType": "code.review",
    "agentType": "reviewer",
    "priority": "p1",
    "triggerType": "sync",
    "timeoutMs": 60000,
    "input": {
      "prompt": "请审查这次改动"
    },
    "trace": {
      "correlationId": "corr-WF-1001"
    }
  }'
```

### 异步示例

```bash
curl -X POST http://127.0.0.1:3000/v1/agent-tasks \
  -H 'content-type: application/json' \
  -d '{
    "idempotencyKey": "WF-2001:analysis:v1",
    "tenantId": "acme",
    "taskType": "requirement.analysis",
    "agentType": "requirement-analyst",
    "priority": "p1",
    "triggerType": "async",
    "timeoutMs": 120000,
    "input": {
      "prompt": "请分析这个需求并输出建议",
      "metadata": {
        "approvalToken": "approve-2001"
      }
    },
    "trace": {
      "correlationId": "corr-WF-2001"
    }
  }'
```

### 查询状态

```bash
curl http://127.0.0.1:3000/v1/agent-tasks/<taskId>
```
