# 专家主页信息抽取接口（业务方简版）

业务方只需要对接这一个接口：

```text
POST /v1/expert-profiles/extract
```

它的职责很简单：

> 传入专家主页 URL，返回专家结构化数据，用于「专家主页同步」弹窗右侧的主页获取值。

## 1. 地址

```text
POST http://192.168.135.172:3000/v1/expert-profiles/extract
```

生产环境请替换成你们的网关地址。

## 2. 鉴权

请求头必须带 Bearer token：

```text
Authorization: Bearer 49d6209cde82775d7d47995d17ce1a2f2b29b7bcb820b4c540f449ba90a74097
Content-Type: application/json
```

## 3. 请求体

```json
{
  "url": "https://www.webofscience.com/wos/author/record/917221",
  "requestId": "expert-sync-20260415-001"
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | 专家主页 URL |
| `requestId` | 否 | 业务请求唯一标识，建议传同步记录 ID / 工单号 |

## 4. 响应状态码

| HTTP 状态码 | 含义 |
|---|---|
| `200` | 抽取成功，`status` 为 `SUCCEEDED` 或 `PARTIAL` |
| `400` | 请求体不合法，例如缺少 `url` |
| `401` | token 缺失或错误 |
| `502` | 抽取执行失败 |
| `504` | 抽取超时 |

## 5. 成功响应

成功时返回 `HTTP 200`，`status` 可能是：

- `SUCCEEDED`：抽取完整成功
- `PARTIAL`：部分字段缺失，但仍可用于弹窗对比

```json
{
  "success": true,
  "status": "SUCCEEDED",
  "promptTokens": 0,
  "completionTokens": 0,
  "totalTokens": 0,
  "data": {
    "avatar": "https://example.edu.cn/faculty/yang.jpg",
    "surname": "杨建涛",
    "sex": 1,
    "birthday": null,
    "country": 1,
    "countryCode": 86,
    "province": 9,
    "city": 0,
    "organization": "上海理工大学",
    "department": "健康科学与工程学院",
    "domain": 8,
    "direction": "康复机器人,可穿戴监测设备",
    "professional": 2,
    "position": "硕士研究生指导教师",
    "phone": null,
    "tel": "021-55270127",
    "email": "jty@usst.edu.cn",
    "contact": null,
    "content": "机器人学博士，毕业于上海交通大学（2020），现为上海理工大学健康科学与工程学院康复工程与技术研究所副教授。入选上海理工大学志远计划，主要研究领域包括生物力学、康复机器人、穿戴式传感器技术等。",
    "academic": "中国人工智能学会智能机器人专委会委员",
    "journal": null,
    "title": 0,
    "tags": "21"
  },
  "error": null
}
```

业务方通常只需要关心这几个字段：

| 字段 | 说明 |
|---|---|
| `success` | 是否拿到了可用数据 |
| `status` | `SUCCEEDED` / `PARTIAL` / `FAILED` 等 |
| `data` | 主页抽取出的结构化字段 |
| `error` | 失败原因 |

`promptTokens` / `completionTokens` / `totalTokens` 主要用于排障和计量。  
注意：实际调用时，如果底层 run 没有回传 token usage，这三个字段可能都是 `0`，这不代表请求失败。

## 6. `data` 字段说明

| # | 中文字段 | `data` 字段 | 类型 | 说明 |
|---|---|---|---|---|
| 1 | 头像 | `avatar` | string \| null | 头像的图片地址 |
| 2 | 姓名 | `surname` | string \| null | 优先中文名 |
| 3 | 性别 | `sex` | number | `0=未知 / 1=男 / 2=女` |
| 4 | 出生年月 | `birthday` | string \| null | 格式 `YYYY` 或 `YYYY-MM` |
| 5 | 国家地区 | `country` | number | 国家字典 ID，未知为 `0` |
| 6 | 国际区号 | `countryCode` | number \| null | 如中国 `86`、美国 `1` |
| 7 | 省份 | `province` | number | 省份字典 ID，未知为 `0` |
| 8 | 城市 | `city` | number | 城市字典 ID，未知为 `0` |
| 9 | 单位 | `organization` | string \| null | 当前主要任职单位 |
| 10 | 学院/部门 | `department` | string \| null | 可能是「学院 / 系」拼接 |
| 11 | 研究领域 | `domain` | number | 研究领域字典 ID，未知为 `0` |
| 12 | 研究方向 | `direction` | string \| null | 逗号分隔字符串 |
| 13 | 职称 | `professional` | number | 职称字典 ID，未知为 `0` |
| 14 | 职务 | `position` | string \| null | 主职务文本 |
| 15 | 手机号 | `phone` | string \| null | 只放手机号 |
| 16 | 固定电话 | `tel` | string \| null | 只放固定电话/办公电话 |
| 17 | 电子邮箱 | `email` | string \| null | 主页能抓到才返回 |
| 18 | 备用联系方式 | `contact` | string \| null | 微信 / ORCID / Scholar / 办公地点等备选联系方式，没有则为 null |
| 19 | 简介 | `content` | string \| null | 中文简介 |
| 20 | 社会兼职 | `academic` | string \| null | 学会 / 协会 / 委员会兼职，逗号分隔 |
| 21 | 期刊资源 | `journal` | string \| null | 编委 / 审稿人 / 主编等，逗号分隔 |
| 22 | 头衔 | `title` | number | 位运算值 |
| 23 | 标签-基本信息 | `tags` | string \| null | 逗号分隔标签 ID |

## 7. `tags` 固定结构

`tags` 永远返回 3 个固定键：

```json
{
  "position": [],
  "experience": [],
  "other": []
}
```

说明：

- `position`：职务类标签
- `experience`：经历类标签
- `other`：其它类标签

没有证据时，对应字段返回空数组 `[]`。

## 8. 失败响应

### 8.1 token 错误

```json
{
  "success": false,
  "status": null,
  "promptTokens": 0,
  "completionTokens": 0,
  "totalTokens": 0,
  "data": null,
  "error": {
    "stage": "validation",
    "code": "unauthorized",
    "message": "Unauthorized: invalid or missing API token",
    "retryable": false
  }
}
```

### 8.2 抽取失败

```json
{
  "success": false,
  "status": "FAILED",
  "promptTokens": 0,
  "completionTokens": 0,
  "totalTokens": 0,
  "data": null,
  "error": {
    "stage": "platform",
    "code": "task.processing_failed",
    "message": "expert extraction failed",
    "retryable": false
  }
}
```

### 8.3 抽取超时

```json
{
  "success": false,
  "status": "TIMED_OUT",
  "promptTokens": 0,
  "completionTokens": 0,
  "totalTokens": 0,
  "data": null,
  "error": {
    "stage": "platform",
    "code": "run.timeout",
    "message": "Task 'task_xxx' exceeded timeout of 180000ms",
    "retryable": false
  }
}
```

## 9. 最小调用示例

```bash
curl -X POST http://192.168.135.172:3000/v1/expert-profiles/extract \
  -H 'Authorization: Bearer 49d6209cde82775d7d47995d17ce1a2f2b29b7bcb820b4c540f449ba90a74097' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://www.webofscience.com/wos/author/record/917221",
    "requestId": "expert-sync-20260415-001"
  }'
```
