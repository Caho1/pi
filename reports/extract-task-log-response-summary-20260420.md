# Extract 接口任务日志与实际回包总结

## 结论先看

- 这 6 次调用里，`200` 时当前接口实际返回的是 `{"status":200,"data":{...}}`。
- `500` 时当前接口实际返回的不是文档里的 `success/status/data/error` 包装，而是更瘦的 `{"status":500,"error":{...}}`。
- 最容易误判的一点是：**任务层 `status=SUCCEEDED`，业务接口仍然可能返回 `500`**。这次的 `requestId=32/33/34/191` 都属于这种情况。
- `requestId=19` 是另一类 `500`：不是抽空，而是**命中了旧的失败缓存记录**，所以直接返回历史 `run.unhandled_error`。

## 样本范围

本次核对了你贴出来的 6 次请求：

| requestId | URL | taskId | 控制面日志 HTTP | 任务状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `32` | `https://t1.ais.cn:7779/expert/main` | `task_1d9404ef-6887-439b-b66a-3190ac065775` | `500` | `SUCCEEDED` | 空档案 |
| `33` | `https://t1.ais.cn:7779/expert/main` | `task_d650a0e8-f281-4312-9c9d-868d9e63a8e0` | `500` | `SUCCEEDED` | 空档案 |
| `34` | `https://t1.ais.cn:7779/expert/main` | `task_232f9c21-2aa8-445d-9898-e4fa6dd637ce` | `500` | `SUCCEEDED` | 空档案 |
| `19` | `https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm` | `task_d8c13db9-6fb7-4c1b-b21f-ad49af8713e5` | `500` | `FAILED` | 命中旧缓存 |
| `190` | `https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm` | `task_1e24f9a9-fa46-438c-85a2-a778c27a4b65` | `200` | `SUCCEEDED` | 正常成功 |
| `191` | `https://jiankang.usst.edu.cn/2021/0611/page.htm` | `task_75c09b89-dad1-4d73-98f2-ffbdb497bc2a` | `500` | `SUCCEEDED` | 空档案 |

## 实际回包

### 1. `200` 成功时，实际回包

样本：`requestId=190`

```json
{
  "status": 200,
  "data": {
    "avatar": "https://jiankang.usst.edu.cn/_upload/article/images/a2/2e/d4bff659493d8bc2aa99a6a2dc9f/5e44f059-7e09-4aac-b213-0dc953f7309b.png",
    "surname": "杨建涛",
    "sex": 0,
    "birthday": null,
    "country": 1,
    "countryCode": 86,
    "province": 9,
    "city": 0,
    "organization": "上海理工大学",
    "department": "健康科学与工程学院 / 康复工程与技术研究所",
    "domain": 8,
    "direction": "康复机器人,可穿戴监测设备,机器人学,人机系统智能感知与控制",
    "professional": 2,
    "position": "硕士研究生导师",
    "phone": null,
    "tel": "021-55270127",
    "email": "jty@usst.edu.cn",
    "contact": null,
    "content": "杨建涛，机器人学博士，毕业于上海交通大学，现任上海理工大学健康科学与工程学院康复工程与技术研究所副教授、硕士研究生导师，主要研究康复机器人、可穿戴监测设备、机器人学、人机系统智能感知与控制，入选上海理工大学志远计划，近年主持并参与国家重点研发计划、国家自然科学基金面上项目等10余项。",
    "academic": "自动化学会机器人智能专委会委员,计算机学会智能机器人专委会执行委员,指控学会可穿戴专委会委员",
    "journal": null,
    "title": 0,
    "tags": "8,21"
  }
}
```

对应任务层状态：

- `task.status = SUCCEEDED`
- `task.error = null`
- `result.error = null`
- `result.structured` 含完整专家资料

这类链路是最直观的：任务成功，业务接口也返回 `200`。

### 2. `500` 且 `error.code=empty_profile` 时，实际回包

样本：`requestId=32/33/34/191`

```json
{
  "status": 500,
  "error": {
    "stage": "validation",
    "code": "empty_profile",
    "message": "Extractor returned an empty expert profile payload",
    "retryable": false
  }
}
```

对应任务层状态：

- `task.status = SUCCEEDED`
- `task.error = null`
- `result.error = null`
- `result.structured` 不是报错，而是一个**全空结构**

这批任务的共同点是：

- trace 里 extractor 判断页面不是有效专家主页
- 最终提交了空信封，或者输出了空信封 JSON
- 控制面在业务包装层又做了一次“是否有有效专家字段”的判断
- 因为 `translated data` 全空，所以虽然任务层成功，接口最终仍返回 `500 empty_profile`

空信封的核心样子就是：

```json
{
  "avatar": null,
  "surname": null,
  "sex": 0,
  "birthday": null,
  "country": 0,
  "countryCode": null,
  "province": 0,
  "city": 0,
  "organization": null,
  "department": null,
  "domain": 0,
  "direction": null,
  "professional": 0,
  "position": null,
  "phone": null,
  "tel": null,
  "email": null,
  "contact": null,
  "content": null,
  "academic": null,
  "journal": null,
  "title": 0,
  "tags": null
}
```

#### 额外观察

- `requestId=32` 和 `34` 的 trace 里能看到显式 `submit_result`，内容就是上面的空信封。
- `requestId=33` 的 trace 里我没有看到显式 `submit_result` 工具调用，但 assistant 在最终文本里输出了空信封 JSON；平台最后仍然生成了 `SUCCEEDED + empty structured` 结果。

这说明当前 worker 不只会吃 `submit_result`，也可能从最终文本里解析 JSON 作为结构化结果。

### 3. `500` 且 `error.code=run.unhandled_error` 时，实际回包

样本：`requestId=19`

```json
{
  "status": 500,
  "error": {
    "stage": "platform",
    "code": "run.unhandled_error",
    "message": "Run settled preconditions were met, but at least one finalizer failed.",
    "retryable": false
  }
}
```

对应任务层状态：

- `task.status = FAILED`
- `task.error.code = run.unhandled_error`
- `result.error.code = run.unhandled_error`
- 这次请求 `deduped=true`

也就是说，这不是本次新跑出来的失败，而是控制面命中了一个 **2026-04-17 就已经失败的旧终态任务**，直接把历史错误返回了出来，所以控制面日志里才会出现：

```text
500 hit cached terminal record — upstream is reusing idempotencyKey/requestId "19"
```

## 任务层和接口层的对应关系

可以把当前链路理解成两层：

### 任务层

- 看 `task.status`
- 看 `task.error` / `result.error`
- 看 agent 最终有没有产出 `structured`

### 业务接口层

- 先把任务结果翻译成业务字段
- 再检查这个业务字段是不是“有意义的专家档案”
- 如果翻译后全空，即使任务层是 `SUCCEEDED`，仍然返回 `500 empty_profile`

所以当前并不是简单的：

```text
task.status == SUCCEEDED  => HTTP 200
```

而更像是：

```text
task.status == SUCCEEDED 且 translated data 有效  => HTTP 200
task.status == SUCCEEDED 但 translated data 全空  => HTTP 500 empty_profile
task.status == FAILED                           => HTTP 500 platform error
```

## 这 6 次调用可以归纳成什么

### `200` 的时候

- 当前接口返回 `status + data`
- `data` 是完整专家档案
- 任务层通常也是 `SUCCEEDED`

### `500` 的时候

目前至少有两种完全不同的来源：

1. 任务成功，但抽出来的是空档案

- 任务层：`SUCCEEDED`
- 接口层：`500 empty_profile`

2. 任务本身就失败，或者命中历史失败缓存

- 任务层：`FAILED`
- 接口层：`500 platform error`

## 对接口语义的直接判断

如果上游只看 HTTP `200/500`，现在会把下面两种情况混成一类失败：

- 真正的平台执行失败
- 平台正常执行完成，但业务上判定“抽到的是空专家档案”

这也是为什么单看控制面日志很容易困惑：

- 日志里写着 `status=SUCCEEDED`
- 但同一行又写着 `httpStatus=500`

这不是日志错了，而是**任务成功 != 业务结果可用**。

## 建议重点关注

- 如果要和文档对齐，当前 `500` 回包还缺少 `success / data / promptTokens / completionTokens / totalTokens` 这些字段。
- 如果要降低排障成本，建议把 `empty_profile` 和 `platform failure` 在响应体里做更明显区分。
- 如果要避免“同一个 requestId 重放历史失败”，上游必须确保 `requestId` 真正唯一，或者显式清理旧终态记录。
