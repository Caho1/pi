# Extract 接口最近任务总结

## 结论先看

- 这 4 次调用的共同结果都是：`HTTP 200`，但响应体里的 `status=400`，错误码统一是 `empty_profile`。
- 任务层并没有失败，4 个任务的 `taskStatus` 都是 `SUCCEEDED`，说明平台执行链路是通的。
- 失败点都落在业务包装层：抽取结果被判定为“空专家档案”，所以最终返回 `bodyStatus=400`。
- `t1.ais.cn:7779/expert/main` 连续 3 次重试都得到同样结论，且耗时逐次变长，没有出现一次成功样本，基本可以认定这个 URL 本身不适合作为专家主页抽取入口。
- `Google Drive` 这个链接也被判成 `empty_profile`，大概率不是公开可直接解析的专家主页 HTML，而是文件分享页。

## 汇总表

| requestId | URL | taskId | runId | HTTP 状态 | body.status | taskStatus | error.code | 耗时 | 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| `38` | `https://drive.google.com/file/d/1p5tA6eTTbw4tnIShTrsLTyUD6mKx1zYb/view?usp=drive_link` | `task_0e32cc01-10f5-4be7-ba4a-312f0287740a` | `run_9897b5fb-d9bd-4166-ac19-0ca7f8b8da3a` | `200` | `400` | `SUCCEEDED` | `empty_profile` | `10.87s` | 分享页/文件页，不像专家主页 |
| `39` | `https://t1.ais.cn:7779/expert/main` | `task_b660f285-74d7-4082-9f06-752905939af9` | `run_9eda090e-2126-41a4-8875-e5ed756a2919` | `200` | `400` | `SUCCEEDED` | `empty_profile` | `24.84s` | 系统主页/SPA |
| `40` | `https://t1.ais.cn:7779/expert/main` | `task_e9fe2718-a23e-4d57-97fb-0b998a4f7b58` | `run_9df18d0f-f425-4e09-bf82-53909e3fc06d` | `200` | `400` | `SUCCEEDED` | `empty_profile` | `54.54s` | 重试后仍为空档案 |
| `41` | `https://t1.ais.cn:7779/expert/main` | `task_64db7b34-1216-48ce-904e-059bbd01ee9e` | `run_3842c23b-5e46-47b1-995d-33b69f2fe7bc` | `200` | `400` | `SUCCEEDED` | `empty_profile` | `74.28s` | 再次重试仍为空档案 |

## 逐条说明

### 1. requestId=`38`

- URL: `https://drive.google.com/file/d/1p5tA6eTTbw4tnIShTrsLTyUD6mKx1zYb/view?usp=drive_link`
- 结果：`httpStatus=200`，`bodyStatus=400`
- 任务状态：`SUCCEEDED`
- 错误：`validation.empty_profile`
- 耗时：`10873ms`

判断：

- 平台成功跑完了抽取流程，但最终没有拿到可用专家字段。
- 这个链接是 Google Drive 文件分享页，不是标准专家主页 URL，命中 `empty_profile` 是合理结果。

### 2. requestId=`39`

- URL: `https://t1.ais.cn:7779/expert/main`
- 结果：`httpStatus=200`，`bodyStatus=400`
- 任务状态：`SUCCEEDED`
- 错误：`validation.empty_profile`
- 耗时：`24840ms`

判断：

- 这是第一次针对该 URL 的本轮调用。
- 平台执行正常，但抽取结果为空，说明页面内容不符合专家主页证据要求。

### 3. requestId=`40`

- URL: `https://t1.ais.cn:7779/expert/main`
- 结果：`httpStatus=200`，`bodyStatus=400`
- 任务状态：`SUCCEEDED`
- 错误：`validation.empty_profile`
- 耗时：`54544ms`

判断：

- 与 `39` 完全相同的业务结论，只是耗时明显更长。
- 这更像页面访问/内容解析过程变慢，而不是结果发生变化。

### 4. requestId=`41`

- URL: `https://t1.ais.cn:7779/expert/main`
- 结果：`httpStatus=200`，`bodyStatus=400`
- 任务状态：`SUCCEEDED`
- 错误：`validation.empty_profile`
- 耗时：`74277ms`

判断：

- 第三次针对同一 URL 的调用，仍然是空档案。
- 说明这不是偶发失败，而是该入口本身就不满足抽取条件。

## 这几次任务说明了什么

### 1. 平台链路是正常的

- 请求能进控制面
- 任务能创建
- run 能完成
- 任务最终状态都是 `SUCCEEDED`

所以这批问题不是平台执行失败，也不是 worker 崩了。

### 2. 失败集中在“输入 URL 不像专家主页”

- `Google Drive`：文件分享页
- `t1.ais.cn:7779/expert/main`：更像系统主页 / SPA 入口页

它们都不是“单个专家详情页”这种稳定的 HTML 页面，所以最后统一落到 `empty_profile`。

### 3. 当前接口语义已经切成“HTTP 200 + body.status 表达业务错误”

这 4 次日志都验证了新的接口语义：

```json
{
  "status": 400,
  "error": {
    "stage": "validation",
    "code": "empty_profile",
    "message": "Extractor returned an empty expert profile payload",
    "retryable": false
  }
}
```

只是 HTTP 层返回 `200`，避免调用方因为 4xx/5xx 直接吞掉响应体。

## 建议

- 对 `Google Drive` 链接，先拿到真实公开网页或文件内容地址，再做抽取，不要直接喂分享页。
- 对 `t1.ais.cn:7779/expert/main`，不要继续重复测这个入口页了，应该改成系统里某位专家的详情页 URL。
- 如果业务侧要做自动判断，可以把 `error.code == "empty_profile"` 视为“URL 不符合专家主页要求”，而不是平台故障。
