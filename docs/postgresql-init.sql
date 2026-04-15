-- Pi 平台 PostgreSQL 初始表结构设计
-- 设计目标：
-- 1. 先兼容当前文件系统版本的数据模型，降低迁移成本。
-- 2. 把高频筛选字段结构化，便于检索、统计和分页。
-- 3. 保留 JSONB 承载弹性字段，避免过早把所有嵌套对象过度拆表。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_priority') THEN
    CREATE TYPE task_priority AS ENUM ('p0', 'p1', 'p2', 'p3');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_trigger_type') THEN
    CREATE TYPE task_trigger_type AS ENUM ('sync', 'async', 'callback');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_lifecycle_status') THEN
    CREATE TYPE task_lifecycle_status AS ENUM (
      'RECEIVED',
      'DEDUPING',
      'REJECTED',
      'ROUTED',
      'PREPARING',
      'RUNNING',
      'SETTLING',
      'SUCCEEDED',
      'PARTIAL',
      'FAILED',
      'TIMED_OUT',
      'CANCELLING',
      'CANCELLED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'run_status') THEN
    CREATE TYPE run_status AS ENUM ('succeeded', 'failed', 'cancelled', 'timed_out', 'partial');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'queue_state') THEN
    CREATE TYPE queue_state AS ENUM ('pending', 'leased', 'failed', 'done');
  END IF;
END $$;

-- 编译后的 Agent Spec 独立存档，避免每个任务重复存整份 spec。
-- 同时保留 spec_json，便于后续灰度排查和审计回放。
CREATE TABLE IF NOT EXISTS agent_specs (
  spec_id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  regression_suite_version TEXT,
  workspace_mode TEXT NOT NULL,
  tool_policy JSONB NOT NULL,
  model_policy JSONB NOT NULL,
  workspace_policy JSONB NOT NULL,
  compaction_policy JSONB NOT NULL,
  output_contract JSONB NOT NULL,
  session_reuse_policy JSONB NOT NULL,
  subagent_policy JSONB NOT NULL,
  completion_policy JSONB NOT NULL,
  extension_governance JSONB NOT NULL,
  cost_policy JSONB NOT NULL,
  retry_policy JSONB NOT NULL,
  build_info JSONB NOT NULL,
  resources JSONB NOT NULL,
  prompts JSONB NOT NULL,
  spec_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_specs_agent_type_version
  ON agent_specs (agent_type, version);

-- 任务主表：保留当前 TaskRecord 的业务主键和高频查询字段。
-- envelope、错误详情等仍保留 JSONB，兼容现有结构并降低迁移难度。
CREATE TABLE IF NOT EXISTS agent_tasks (
  task_id TEXT PRIMARY KEY,
  idempotency_fingerprint TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  agent_version_selector TEXT,
  priority task_priority NOT NULL,
  trigger_type task_trigger_type NOT NULL,
  timeout_ms INTEGER NOT NULL,
  deadline_at TIMESTAMPTZ,
  callback_url TEXT,
  callback_topic TEXT,
  callback_headers JSONB,
  input_prompt TEXT NOT NULL,
  input_structured JSONB,
  input_context_refs JSONB,
  input_metadata JSONB,
  constraints_json JSONB,
  trace_correlation_id TEXT NOT NULL,
  trace_parent_task_id TEXT,
  trace_requester TEXT,
  trace_source_system TEXT,
  spec_id TEXT NOT NULL REFERENCES agent_specs(spec_id),
  status task_lifecycle_status NOT NULL,
  latest_run_id TEXT,
  artifacts_count INTEGER NOT NULL DEFAULT 0,
  envelope_json JSONB NOT NULL,
  error_stage TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retryable BOOLEAN,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_tenant_created_at
  ON agent_tasks (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_created_at
  ON agent_tasks (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_task_type_created_at
  ON agent_tasks (task_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_type_created_at
  ON agent_tasks (agent_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_trace_correlation_id
  ON agent_tasks (trace_correlation_id);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_spec_id
  ON agent_tasks (spec_id);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_input_structured_gin
  ON agent_tasks USING GIN (input_structured);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_envelope_json_gin
  ON agent_tasks USING GIN (envelope_json);

-- 运行记录表：虽然当前文件版 TaskRecord 只保留 latest result，
-- 但迁移到 PG 后建议独立建 run 表，为重试、补偿和历史审计留足空间。
CREATE TABLE IF NOT EXISTS agent_task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL REFERENCES agent_specs(spec_id),
  status run_status NOT NULL,
  completion_json JSONB NOT NULL,
  result_text TEXT,
  result_structured JSONB,
  submission_mode TEXT,
  usage_provider TEXT,
  usage_model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  estimated_cost_usd NUMERIC(18, 6),
  turns INTEGER,
  subagent_count INTEGER,
  compaction_happened BOOLEAN NOT NULL DEFAULT FALSE,
  compaction_count INTEGER,
  compaction_policy_mode TEXT,
  retries INTEGER,
  failover_attempts INTEGER,
  warnings JSONB,
  failures JSONB,
  error_stage TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retryable BOOLEAN,
  error_details JSONB,
  queued_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  raw_result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_task_runs_task_id_created_at
  ON agent_task_runs (task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_task_runs_status_started_at
  ON agent_task_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_task_runs_provider_model
  ON agent_task_runs (usage_provider, usage_model);

CREATE INDEX IF NOT EXISTS idx_agent_task_runs_result_structured_gin
  ON agent_task_runs USING GIN (result_structured);

-- Artifact 独立索引，后续可以平滑把 uri 从本地文件路径切到 OSS/S3。
CREATE TABLE IF NOT EXISTS agent_task_artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_task_runs(run_id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  digest TEXT,
  media_type TEXT,
  title TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_task_artifacts_task_id
  ON agent_task_artifacts (task_id);

CREATE INDEX IF NOT EXISTS idx_agent_task_artifacts_run_id
  ON agent_task_artifacts (run_id);

CREATE INDEX IF NOT EXISTS idx_agent_task_artifacts_kind
  ON agent_task_artifacts (kind);

-- 队列表。即便后续切到 SKIP LOCKED 模式，这张表也仍然能承载排队和失败状态。
CREATE TABLE IF NOT EXISTS agent_task_queue_items (
  queue_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  state queue_state NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_task_queue_items_state_enqueued_at
  ON agent_task_queue_items (state, enqueued_at);

CREATE INDEX IF NOT EXISTS idx_agent_task_queue_items_lease_expires_at
  ON agent_task_queue_items (lease_expires_at);

-- Trace 事件明细。当前文件版是 jsonl，迁移后建议逐条入库，方便按 run 检索。
CREATE TABLE IF NOT EXISTS agent_task_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_task_runs(run_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  raw_type TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  delta TEXT,
  accumulated_text TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  payload JSONB,
  is_error BOOLEAN NOT NULL DEFAULT FALSE,
  raw_event JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_task_run_events_run_id_event_time
  ON agent_task_run_events (run_id, event_time);

CREATE INDEX IF NOT EXISTS idx_agent_task_run_events_task_id_event_time
  ON agent_task_run_events (task_id, event_time);

CREATE INDEX IF NOT EXISTS idx_agent_task_run_events_event_type
  ON agent_task_run_events (event_type);

CREATE INDEX IF NOT EXISTS idx_agent_task_run_events_payload_gin
  ON agent_task_run_events USING GIN (payload);

-- 审计表：保留最终落地快照，避免 dashboard 全靠在线聚合 task_runs。
CREATE TABLE IF NOT EXISTS agent_audit_log_entries (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  run_id TEXT,
  spec_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  regression_suite_version TEXT,
  provider TEXT,
  model TEXT,
  workspace_mode TEXT NOT NULL,
  compaction_happened BOOLEAN NOT NULL DEFAULT FALSE,
  failover_attempts INTEGER NOT NULL DEFAULT 0,
  submit_result_used BOOLEAN NOT NULL DEFAULT FALSE,
  artifacts_count INTEGER NOT NULL DEFAULT 0,
  final_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_log_entries_created_at
  ON agent_audit_log_entries (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_audit_log_entries_tenant_id
  ON agent_audit_log_entries (tenant_id, created_at DESC);

-- 任务级死信表，对应当前 task-dlq.jsonl。
CREATE TABLE IF NOT EXISTS agent_task_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_task_dead_letters_task_id
  ON agent_task_dead_letters (task_id, created_at DESC);

-- 回调投递失败表，对应当前 callback-dlq.jsonl。
CREATE TABLE IF NOT EXISTS agent_callback_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  callback_url TEXT NOT NULL,
  payload JSONB NOT NULL,
  headers JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_callback_dead_letters_created_at
  ON agent_callback_dead_letters (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_callback_dead_letters_task_id
  ON agent_callback_dead_letters (task_id, created_at DESC);

-- 激活版本映射表，对应 active-versions.json。
CREATE TABLE IF NOT EXISTS agent_active_versions (
  agent_type TEXT PRIMARY KEY,
  active_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================
-- Profile 抽取业务域表
-- 统一使用 agent_profile_ 前缀
-- =========================

-- Profile 大宽表。
-- 目标是先快速承接当前抽取结果与业务回填场景，减少多表 join 和迁移复杂度。
-- 多值字段先使用 TEXT[] / JSONB 存储，后续只有在检索压力明显增大时再拆分。
CREATE TABLE IF NOT EXISTS agent_profile_records (
  profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL UNIQUE REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_task_runs(run_id) ON DELETE SET NULL,
  tenant_id TEXT NOT NULL,
  request_id TEXT,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'url',
  task_status task_lifecycle_status NOT NULL,
  extracted_at TIMESTAMPTZ NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  name TEXT,
  gender TEXT,
  birth_date TEXT,
  country_code INTEGER,
  country_name TEXT,
  institution_name TEXT,
  college_department TEXT,
  academic_title_code INTEGER,
  academic_title_name TEXT,
  admin_title TEXT,
  phone TEXT,
  email TEXT,
  contact TEXT,
  contact_preferred TEXT,
  bio TEXT,
  avatar_url TEXT,
  research_areas TEXT[] NOT NULL DEFAULT '{}',
  research_area_codes INTEGER[] NOT NULL DEFAULT '{}',
  research_directions TEXT[] NOT NULL DEFAULT '{}',
  social_positions TEXT[] NOT NULL DEFAULT '{}',
  journal_resources TEXT[] NOT NULL DEFAULT '{}',
  title_names TEXT[] NOT NULL DEFAULT '{}',
  title_codes INTEGER[] NOT NULL DEFAULT '{}',
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot JSONB,
  fields_from_rule TEXT[] NOT NULL DEFAULT '{}',
  fields_from_llm TEXT[] NOT NULL DEFAULT '{}',
  fields_missing TEXT[] NOT NULL DEFAULT '{}',
  error_stage TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retryable BOOLEAN,
  structured_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_tenant_created_at
  ON agent_profile_records (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_name
  ON agent_profile_records (name);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_institution_name
  ON agent_profile_records (institution_name);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_country_code
  ON agent_profile_records (country_code);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_task_status_created_at
  ON agent_profile_records (task_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_source_url
  ON agent_profile_records (source_url);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_research_areas_gin
  ON agent_profile_records USING GIN (research_areas);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_research_area_codes_gin
  ON agent_profile_records USING GIN (research_area_codes);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_title_names_gin
  ON agent_profile_records USING GIN (title_names);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_title_codes_gin
  ON agent_profile_records USING GIN (title_codes);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_tags_gin
  ON agent_profile_records USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_agent_profile_records_structured_json_gin
  ON agent_profile_records USING GIN (structured_json);
