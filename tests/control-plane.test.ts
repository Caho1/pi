import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";
import type { RunResult } from "../packages/agent-contracts/src/index.js";

describe("control plane API", () => {
  afterEach(async () => {
    delete process.env.EXPERT_PROFILE_API_TOKEN;
    await Promise.all([
      fs.rm("runtime/test-control-plane", { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      fs.rm("runtime/test-control-plane-approval", { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      fs.rm("runtime/test-control-plane-approved", { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      fs.rm("runtime/test-control-plane-failed", { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      fs.rm("runtime/test-control-plane-expert-profile", { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      fs.rm("runtime/test-control-plane-expert-profile-failed", {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ]);
  });

  test("deduplicates idempotent requests and surfaces stored task state", async () => {
    const cannedResult: RunResult = {
      taskId: "task-test",
      runId: "run-test",
      specId: "sha256:test",
      status: "succeeded",
      completion: {
        barrier: "settled-barrier",
        promptResolved: true,
        terminalEventSeen: true,
        noPendingBackgroundWork: true,
        finalizerPassed: true,
      },
      result: {
        submissionMode: "submit_result",
        structured: {
          summary: "Looks good",
          verdict: "approve",
          findings: [],
        },
      },
      artifacts: [],
      timestamps: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    };

    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane",
      processor: {
        async process(task) {
          return {
            ...cannedResult,
            taskId: task.taskId,
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const payload = {
      idempotencyKey: "req-1",
      tenantId: "acme",
      taskType: "code.review",
      priority: "p1",
      triggerType: "sync",
      timeoutMs: 1000,
      input: {
        prompt: "Review the change",
      },
      trace: {
        correlationId: "corr-1",
      },
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(202);

    const firstBody = first.json();
    const secondBody = second.json();
    expect(secondBody.taskId).toBe(firstBody.taskId);

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/agent-tasks/${firstBody.taskId}`,
    });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().status).toBe("SUCCEEDED");

    await app.close();
  });

  test("rejects high-risk tasks without approval before enqueueing", async () => {
    let processCalls = 0;
    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-approval",
      processor: {
        async process() {
          processCalls += 1;
          throw new Error("不应该执行到 processor");
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "approval-1",
        tenantId: "acme",
        taskType: "requirement.analysis",
        priority: "p1",
        triggerType: "async",
        timeoutMs: 1000,
        input: {
          prompt: "请分析需求并给出建议",
        },
        trace: {
          correlationId: "corr-approval-1",
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("REJECTED");
    expect(response.json().error.code).toBe("approval.required");
    expect(processCalls).toBe(0);

    await app.close();
  });

  test("allows high-risk tasks when approval token is present", async () => {
    let processCalls = 0;
    const cannedResult: RunResult = {
      taskId: "task-approved",
      runId: "run-approved",
      specId: "sha256:approved",
      status: "succeeded",
      completion: {
        barrier: "settled-barrier",
        promptResolved: true,
        terminalEventSeen: true,
        noPendingBackgroundWork: true,
        finalizerPassed: true,
      },
      result: {
        submissionMode: "submit_result",
        structured: {
          summary: "approved",
        },
      },
      artifacts: [],
      timestamps: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    };

    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-approved",
      processor: {
        async process(task) {
          processCalls += 1;
          return {
            ...cannedResult,
            taskId: task.taskId,
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "approval-2",
        tenantId: "acme",
        taskType: "requirement.analysis",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: 1000,
        input: {
          prompt: "请分析需求并给出建议",
          metadata: {
            approvalToken: "ticket-123",
          },
        },
        trace: {
          correlationId: "corr-approval-2",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("SUCCEEDED");
    expect(processCalls).toBe(1);

    await app.close();
  });

  test("sync request exits early when task fails instead of waiting for full timeout", async () => {
    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-failed",
      processor: {
        async process() {
          throw new Error("boom");
        },
        async cancel() {
          return false;
        },
      },
    });

    const startedAt = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "failed-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: 5_000,
        input: {
          prompt: "fail fast",
        },
        trace: {
          correlationId: "corr-failed-1",
        },
      },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("FAILED");
    expect(response.json().error.code).toBe("task.processing_failed");

    await app.close();
  });

  test("expert profile business route wraps url input into a sync task and returns business data", async () => {
    let capturedTaskType = "";
    let capturedAgentType = "";
    let capturedPrompt = "";
    let capturedApprovalToken = "";

    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile",
      processor: {
        async process(task) {
          capturedTaskType = task.envelope.taskType;
          capturedAgentType = task.envelope.agentType;
          capturedPrompt = task.envelope.input.prompt;
          capturedApprovalToken = String(task.envelope.input.metadata?.approvalToken ?? "");

          return {
            taskId: task.taskId,
            runId: "run-expert-profile",
            specId: task.compiledSpec.specId,
            status: "succeeded",
            completion: {
              barrier: "settled-barrier",
              promptResolved: true,
              terminalEventSeen: true,
              noPendingBackgroundWork: true,
              finalizerPassed: true,
            },
            result: {
              submissionMode: "submit_result",
              structured: {
                avatar_url: "https://example.edu/avatar.png",
                name: "张三",
                gender: "male",
                birth_date: "1987-03",
                country_region: "中国",
                institution: "某大学",
                college_department: "计算机学院 / 人工智能系",
                research_areas: ["人工智能"],
                research_directions: ["具身智能", "多模态大模型"],
                academic_title: "副教授",
                admin_title: "博士生导师",
                email: "zhangsan@example.edu",
                contact_preferred: "email",
                bio: "现任某大学副教授，长期从事人工智能与具身智能研究。",
                social_positions: ["中国人工智能学会会员"],
                journal_resources: ["《模式识别与人工智能》审稿人"],
                tags: {
                  academic_honors: ["学科带头人"],
                  institution_tier: ["双一流"],
                  experiences: ["参与学术社团"],
                  others: ["导师职务"],
                },
              },
            },
            artifacts: [],
            usage: {
              inputTokens: 3500,
              outputTokens: 420,
            },
            timestamps: {
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      payload: {
        url: "https://example.edu/faculty/zhangsan",
        requestId: "expert-biz-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      status: "SUCCEEDED",
      promptTokens: 3500,
      completionTokens: 420,
      totalTokens: 3920,
      data: {
        avatar: "https://example.edu/avatar.png",
        name: "张三",
        sex: "男",
        birthday: "1987-03",
        country: {
          value: 1,
          name: "中国",
        },
        organization: "某大学",
        department: "计算机学院 / 人工智能系",
        domain: [
          {
            value: 8,
            name: "人工智能",
          },
        ],
        direction: ["具身智能", "多模态大模型"],
        professional: {
          value: 2,
          name: "副教授",
        },
        position: "博士生导师",
        email: "zhangsan@example.edu",
        contact: null,
        bio: "现任某大学副教授，长期从事人工智能与具身智能研究。",
        academic: ["中国人工智能学会会员"],
        journal: ["《模式识别与人工智能》审稿人"],
        tags: {
          position: ["学科带头人"],
          experience: ["参与学术社团"],
          other: ["双一流", "导师职务"],
        },
      },
      error: null,
    });
    expect(capturedTaskType).toBe("expert.profile.extract");
    expect(capturedAgentType).toBe("expert-profile");
    expect(capturedPrompt).toBe("https://example.edu/faculty/zhangsan");
    expect(capturedApprovalToken.length).toBeGreaterThan(0);

    await app.close();
  });

  test("expert profile business route rejects requests without a valid api token when configured", async () => {
    process.env.EXPERT_PROFILE_API_TOKEN = "secret-token";

    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile",
      processor: {
        async process() {
          throw new Error("不应该执行到 processor");
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      payload: {
        url: "https://example.edu/faculty/zhangsan",
        requestId: "expert-biz-auth-1",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      success: false,
      status: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      data: null,
      error: {
        code: "unauthorized",
      },
    });

    await app.close();
  });

  test("expert profile business route translates coded dictionary fields into labels", async () => {
    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile",
      processor: {
        async process(task) {
          return {
            taskId: task.taskId,
            runId: "run-expert-profile-dicts",
            specId: task.compiledSpec.specId,
            status: "succeeded",
            completion: {
              barrier: "settled-barrier",
              promptResolved: true,
              terminalEventSeen: true,
              noPendingBackgroundWork: true,
              finalizerPassed: true,
            },
            result: {
              submissionMode: "submit_result",
              structured: {
                professional: 2,
                domain: 8,
                title: 9,
                country: "9",
              },
            },
            artifacts: [],
            usage: {
              inputTokens: 20,
              outputTokens: 10,
            },
            timestamps: {
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      payload: {
        url: "https://example.edu/faculty/wangwu",
        requestId: "expert-biz-dicts-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      status: "SUCCEEDED",
      data: {
        professional: {
          value: 2,
          name: "副教授",
        },
        domain: [
          {
            value: 8,
            name: "人工智能",
          },
        ],
        title: [
          {
            value: 1,
            name: "院士",
          },
          {
            value: 8,
            name: "IEEE Fellow",
          },
        ],
        country: {
          value: 9,
          name: "美国",
        },
      },
      error: null,
    });

    await app.close();
  });

  test("expert profile business route translates docs-facing coded fields into labels", async () => {
    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile",
      processor: {
        async process(task) {
          return {
            taskId: task.taskId,
            runId: "run-expert-profile-doc-fields",
            specId: task.compiledSpec.specId,
            status: "succeeded",
            completion: {
              barrier: "settled-barrier",
              promptResolved: true,
              terminalEventSeen: true,
              noPendingBackgroundWork: true,
              finalizerPassed: true,
            },
            result: {
              submissionMode: "submit_result",
              structured: {
                academic_title: "2",
                research_areas: [7, "8"],
                country_region: 9,
              },
            },
            artifacts: [],
            usage: {
              inputTokens: 20,
              outputTokens: 10,
            },
            timestamps: {
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      payload: {
        url: "https://example.edu/faculty/zhaoliu",
        requestId: "expert-biz-dicts-2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      status: "SUCCEEDED",
      data: {
        professional: {
          value: 2,
          name: "副教授",
        },
        domain: [
          {
            value: 7,
            name: "计算机科学与技术",
          },
          {
            value: 8,
            name: "人工智能",
          },
        ],
        country: {
          value: 9,
          name: "美国",
        },
      },
      error: null,
    });

    await app.close();
  });

  test("expert profile business route keeps unmapped dictionary values with null keys", async () => {
    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile",
      processor: {
        async process(task) {
          return {
            taskId: task.taskId,
            runId: "run-expert-profile-dicts-fallback",
            specId: task.compiledSpec.specId,
            status: "succeeded",
            completion: {
              barrier: "settled-barrier",
              promptResolved: true,
              terminalEventSeen: true,
              noPendingBackgroundWork: true,
              finalizerPassed: true,
            },
            result: {
              submissionMode: "submit_result",
              structured: {
                academic_title: "首席科学家",
                research_areas: ["人工智能", "具身智能"],
                country_region: "火星",
              },
            },
            artifacts: [],
            usage: {
              inputTokens: 20,
              outputTokens: 10,
            },
            timestamps: {
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      payload: {
        url: "https://example.edu/faculty/qianqi",
        requestId: "expert-biz-dicts-3",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      status: "SUCCEEDED",
      data: {
        professional: {
          value: null,
          name: "首席科学家",
        },
        domain: [
          {
            value: 8,
            name: "人工智能",
          },
          {
            value: null,
            name: "具身智能",
          },
        ],
        country: {
          value: null,
          name: "火星",
        },
      },
      error: null,
    });

    await app.close();
  });

  test("expert profile business route accepts bearer token when api token is configured", async () => {
    process.env.EXPERT_PROFILE_API_TOKEN = "secret-token";

    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile",
      processor: {
        async process(task) {
          return {
            taskId: task.taskId,
            runId: "run-expert-profile-auth",
            specId: task.compiledSpec.specId,
            status: "succeeded",
            completion: {
              barrier: "settled-barrier",
              promptResolved: true,
              terminalEventSeen: true,
              noPendingBackgroundWork: true,
              finalizerPassed: true,
            },
            result: {
              submissionMode: "submit_result",
              structured: {
                name: "李四",
              },
            },
            artifacts: [],
            usage: {
              inputTokens: 12,
              outputTokens: 8,
            },
            timestamps: {
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      headers: {
        authorization: "Bearer secret-token",
      },
      payload: {
        url: "https://example.edu/faculty/lisi",
        requestId: "expert-biz-auth-2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      status: "SUCCEEDED",
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      data: {
        name: "李四",
      },
      error: null,
    });

    await app.close();
  });

  test("expert profile business route validates missing url before creating a task", async () => {
    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      payload: {
        requestId: "expert-biz-2",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      status: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      data: null,
      error: {
        code: "invalid_request",
      },
    });

    await app.close();
  });

  test("expert profile business route maps failed task status to business error response", async () => {
    const app = await buildControlPlaneApp({
      runtimeRoot: "runtime/test-control-plane-expert-profile-failed",
      processor: {
        async process() {
          throw new Error("expert extraction failed");
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/expert-profiles/extract",
      payload: {
        url: "https://example.edu/faculty/lisi",
        requestId: "expert-biz-3",
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      success: false,
      status: "FAILED",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      data: null,
      error: {
        code: "task.processing_failed",
      },
    });

    await app.close();
  });
});
