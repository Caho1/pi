# PostgreSQL 表结构设计

这版设计是按你当前项目里“本地文件存储”的真实结构反推出来的，目标不是一上来做最复杂的强规范化，而是先做到两件事：

1. 迁移成本低，能平滑承接现有 `TaskRecord` / `RunResult` / queue / audit / dlq 结构。
2. 后续扩展方便，尤其是重试历史、仪表盘统计、trace 检索、artifact 外置存储。

对应的 DDL 已经放在 [postgresql-init.sql](/Users/jiahao/Desktop/PythonProject/pi/docs/postgresql-init.sql)。

## 命名规范

你这次提的方向是对的，表名最好一眼能看出“这是平台通用表，还是某个具体业务域的表”。

我建议统一约定成两层：

- `agent_`：整个 Agent 平台的系统级通用表
- `agent_profile_`：只服务于 profile 抽取业务域的表

按这个规则，这一版 DDL 里已经调整为系统级表统一使用 `agent_` 前缀，例如：

- `agent_tasks`
- `agent_task_runs`
- `agent_task_artifacts`
- `agent_task_queue_items`
- `agent_task_run_events`
- `agent_audit_log_entries`
- `agent_task_dead_letters`
- `agent_callback_dead_letters`
- `agent_specs`
- `agent_active_versions`

这批表都是平台底座能力，不只属于 profile 抽取，因此不应该命名成 `agent_profile_*`。

如果后面你们要把“专家档案抽取结果”也入 PostgreSQL，那么那部分业务表就很适合单独走 `agent_profile_` 前缀。

这次我已经把 `agent_profile_*` 这部分也一起补进 DDL 了。

## 核心建模思路

当前文件系统版本里，真正的主对象是 `TaskRecord`，它里面又嵌了：

- `envelope`：任务请求本体
- `compiledSpec`：编译后的 Agent 规格
- `result`：运行结果
- `artifacts`：产物索引
- `error`：失败信息

如果把这些全部塞进一张 PostgreSQL 大表，短期能跑，但后面会碰到几个问题：

- 重试后只有最新一次运行结果，历史 run 不好追
- trace 仍然只能按大 JSON 查，检索效率差
- dashboard 统计会越来越依赖全表扫描
- artifact 后续切对象存储时，难以独立演进

所以这里用了“主表 + 运行表 + 明细表 + 少量 JSONB”的折中方案。

## 表说明

### `agent_specs`

用来存编译后的 spec 快照。

为什么单独拆出来：

- 一个 spec 会被很多 task 复用
- `spec_id` 本身就是天然稳定主键
- 便于做版本审计、灰度回放、兼容性排查

这里把查询频率较高的字段单独列出来，比如：

- `agent_type`
- `version`
- `sdk_version`
- `adapter_version`
- `workspace_mode`

同时保留一份 `spec_json`，保证后续想完整还原也不丢信息。

### `agent_tasks`

这是任务主表，对应当前的 `TaskRecord`。

建议把高频筛选条件单独结构化出来：

- `tenant_id`
- `task_type`
- `agent_type`
- `priority`
- `trigger_type`
- `status`
- `created_at`
- `updated_at`

把以下内容保留为 JSONB 或半结构化字段：

- `input_structured`
- `input_context_refs`
- `input_metadata`
- `constraints_json`
- `callback_headers`
- `envelope_json`

这样做的好处是：

- 常用查询能走普通索引
- 输入结构差异大时不用频繁改表
- 迁移脚本可以直接从现有 JSON 映射

### `agent_task_runs`

这是我认为最值得提前加上的一张表。

虽然你现在本地文件里只保留了 `latestRunId` 和 `result`，但 PG 化后最好把 run 独立出来。原因很实际：

- 后面做“重试”时，不会覆盖掉上一次结果
- 能区分 task 状态和每次 run 状态
- 成本、tokens、provider、model 都是典型 run 级数据
- dashboard 和审计都更自然

建议保留这些结构化字段：

- `usage_provider`
- `usage_model`
- `input_tokens`
- `output_tokens`
- `estimated_cost_usd`
- `started_at`
- `finished_at`
- `status`

同时把 `completion_json`、`raw_result_json`、`warnings`、`failures` 这些保留为 JSONB。

### `agent_task_artifacts`

当前 artifact 已经有独立的 `artifactId`，非常适合直接建表。

建议字段：

- `artifact_id`
- `task_id`
- `run_id`
- `kind`
- `uri`
- `digest`
- `media_type`
- `title`
- `size_bytes`

注意这里的 `uri` 不要只理解为本地路径。现在是本地文件，后面完全可以平滑切成：

- 本地绝对路径
- `s3://...`
- `oss://...`
- 预签名下载地址

### `agent_task_queue_items`

这张表是对文件版 queue 的直接映射。

当前文件模型里已经有：

- `queueId`
- `taskId`
- `attempts`
- `leaseExpiresAt`
- `lastError`
- `enqueuedAt`

迁移到 PG 后，即便未来想改成更标准的 `FOR UPDATE SKIP LOCKED` 抢占模式，这张表仍然有价值，因为：

- 它可以承接 pending / leased / failed 的状态
- 可以保留失败与重试痕迹
- 运维排查时比内存队列更容易观测

### `agent_task_run_events`

这是 trace 表，对应现在的 `runtime/traces/*.jsonl`。

建议逐条入库，不要只保留整份大文本，因为后面你很可能会查：

- 某个 run 什么时候开始
- 某次 tool 调用的 payload 是什么
- 某类 event 的错误率
- 某个 task 最后输出 delta 到哪里断了

所以表里把：

- `event_type`
- `raw_type`
- `event_time`
- `tool_name`
- `tool_call_id`
- `is_error`

做成结构化字段，而 `payload` 和 `raw_event` 留作 JSONB。

### `agent_audit_log_entries`

这张表对应当前的 `audit.jsonl`，保留不可变审计快照。

理论上很多数据都能从 `agent_task_runs` 聚合出来，但单独留审计表仍然值得，因为：

- 审计口径要稳定，不能依赖后续在线推导
- 看板查询会更轻
- 对账和合规分析更方便

### `agent_task_dead_letters` 与 `agent_callback_dead_letters`

这两张表分别对应当前：

- `task-dlq.jsonl`
- `callback-dlq.jsonl`

这类表不需要太复杂，但一定要有时间索引，方便排障和重放。

### `agent_active_versions`

对应当前 `active-versions.json`。

它很简单，但很关键，因为这个配置本身已经是业务行为的一部分，不应该继续只放文件里。

## 为什么不是全部强拆成很多子表

这版设计刻意保留了一部分 JSONB，是为了避免在迁移一期把复杂度拉太高。

更适合先保持 JSONB 的字段：

- `input_structured`
- `input_metadata`
- `constraints_json`
- `completion_json`
- `raw_result_json`
- `payload`
- `raw_event`
- `spec_json`

更适合结构化的字段：

- 主键、外键、状态、时间
- tenant / taskType / agentType / provider / model
- timeout、tokens、cost
- queue lease / attempts

这个边界比较适合你当前项目阶段。

## 第一阶段迁移建议

如果我们按风险最小来推进，我建议顺序是：

1. 先落 `agent_specs`、`agent_tasks`、`agent_task_runs`、`agent_task_artifacts`
2. 再迁 `agent_task_queue_items`
3. 然后迁 `agent_task_run_events`
4. 最后迁 `agent_audit_log_entries`、`agent_task_dead_letters`、`agent_callback_dead_letters`

原因是前四步已经能承接主业务链路，后面的审计和死信更适合第二阶段补齐。

## 我对你这个项目的建议

如果你希望“尽快迁移成功”，不要一开始就把所有嵌套字段都拆成三范式。

比较合适的策略是：

- `TaskEnvelope` 先做“核心字段结构化 + 原始 envelope_json 兜底”
- `CompiledSpec` 先存一份独立快照表
- `RunResult` 独立成 `agent_task_runs`
- trace 用明细表
- artifact 独立表

## `agent_profile_` 前缀建议怎么用

如果你接下来要把 profile 抽取结果落库，我建议单独放成业务域表，而不是和任务运行表混在一起。

这次收敛后的业务表只有一个主表：

- `agent_profile_records`

这样数据库层次会很清楚：

- `agent_*` 负责“任务怎么跑”
- `agent_profile_*` 负责“profile 结果长什么样”

## Profile 业务表设计

### `agent_profile_records`

这是专家档案大宽表，对应一次抽取落地后的完整业务结果。

这里我建议直接结构化这些字段：

- `task_id`
- `run_id`
- `tenant_id`
- `request_id`
- `source_url`
- `source_type`
- `task_status`
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `name`
- `gender`
- `birth_date`
- `country_code`
- `country_name`
- `institution_name`
- `college_department`
- `academic_title_code`
- `academic_title_name`
- `admin_title`
- `phone`
- `email`
- `contact`
- `contact_preferred`
- `bio`
- `avatar_url`
- `research_areas`
- `research_area_codes`
- `research_directions`
- `social_positions`
- `journal_resources`
- `title_names`
- `title_codes`
- `tags`

同时保留这些元信息：

- `source_snapshot`
- `fields_from_rule`
- `fields_from_llm`
- `fields_missing`
- `error_stage`
- `error_code`
- `error_message`
- `error_retryable`
- `structured_json`

这样做的原因很实际：

- 一张表就能完成读取、回填和大部分检索
- 迁移脚本简单，入库逻辑也简单
- 对当前 profile 抽取这种“单次返回一份对象”的场景更贴近
- `structured_json` 便于回放和兼容未来字段扩展
- `_meta` 信息落库后，后面可以分析抽取质量

## 为什么这里用大宽表

你这个判断是合理的，当前阶段 profile 抽取更像“把一份结构化结果保存下来”，不是高频 OLTP 明细交易模型，所以一张宽表更适合先落地。

主要好处是：

- 开发快，迁移脚本简单
- 查询简单，业务读取几乎不需要 join
- 和当前 `result.structured` 的对象形态接近，映射成本低
- 后面真有需要时，仍然可以从宽表再拆分出明细表

## 多值字段怎么放

这版里我建议：

- 字符串数组直接用 `TEXT[]`
- 字典编码数组用 `INTEGER[]`
- `tags` 这种固定对象用 `JSONB`
- 整份原始结果继续保留 `structured_json`

这样既保持了一张宽表，又保留了基本检索能力。DDL 里我也给这些字段加了 GIN 索引，后续按数组成员或 tags 查询时还能用。

## 推荐落库关系

我建议主链路按这个关系走：

1. `agent_tasks` 保存平台任务
2. `agent_task_runs` 保存运行结果
3. `agent_profile_records` 直接保存 profile 业务结果

这样既保留了平台层和业务层的边界，也不会把 profile 落库做得太重。

这样既不会把查询能力做弱，也不会把迁移复杂度做爆。

如果你愿意，我下一步可以继续直接帮你做两件事里的任意一个：

1. 按这套表结构，继续生成一版 `TypeScript Repository` 接口和 PostgreSQL DAO 分层。
2. 直接开始写“本地 JSON/文件系统 -> PostgreSQL”的迁移脚本。
