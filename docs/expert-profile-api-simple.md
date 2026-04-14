# 专家主页信息抽取接口（业务方对接文档）

本接口服务于数字化系统的「**专家主页同步**」功能：
业务方传入专家主页 URL，接口返回一组结构化字段（共 18 项），用来填充「专家主页同步」弹窗**右栏（主页获取值）**，
供用户与左栏（专家库当前详情值）做左右对比、按字段勾选采纳或一键同步。

业务方只需要对接这一个接口：

```text
POST /v1/expert-profiles/extract
```

---

## 1. 业务场景

参考需求「专家信息支持获取个人主页信息显示」：

- 在「专家总库」或「专家详情」点击「主页同步」按钮
- 系统弹出「专家主页同步」弹窗，左右对比展示
  - **左栏**：专家库当前详情值（不可编辑，缺失为空）
  - **右栏**：由本接口返回的 `data` 字段填充（标记「采纳该字段」来源）
- 用户按字段勾选或一键全选，点击「完成同步」将右栏值写回专家详情

因此本接口的职责是：

> 给定一个专家主页 URL，尽可能抽取出 18 个同步字段所需的结构化数据，交给业务系统做左右对比与逐字段采纳。

**本接口不负责**：

- 不做写入（不修改专家库）
- 不做字段合并（左右对比是业务端的事）
- 不做展示排版（返回原始值，由业务端决定样式）

---

## 2. 接口地址

```text
POST http://127.0.0.1:3000/v1/expert-profiles/extract
```

生产环境请替换为你们网关暴露的地址。

---

## 3. 鉴权

需要在请求头带固定 Bearer token：

```text
Authorization: Bearer 49d6209cde82775d7d47995d17ce1a2f2b29b7bcb820b4c540f449ba90a74097
Content-Type: application/json
```

token 错误时返回 `401`，`error.code = "unauthorized"`。

---

## 4. 请求体

```json
{
  "url": "https://www.webofscience.com/wos/author/record/917221",
  "requestId": "expert-sync-20260414-001"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | 专家主页 URL。支持学校官网、Web of Science、Google Scholar、ORCID 等常见主页 |
| `requestId` | 否 | 业务请求唯一标识；**建议直接传业务端的同步记录 ID / 工单号**，便于排障和幂等 |

关于 `requestId`：

- 本次请求的唯一标识
- 同一个 `requestId` 重复调用会命中幂等，不会重复计费和执行
- 推荐格式：`expert-sync-<专家ID>-<时间戳>` 或直接用主页同步记录表主键

---

## 5. 成功响应

**HTTP 200**，业务上表示主页抽取成功或部分成功（`status` 为 `SUCCEEDED` / `PARTIAL`）。

```json
{
  "success": true,
  "status": "SUCCEEDED",
  "requestId": "expert-sync-20260414-001",
  "taskId": "task_xxx",
  "runId": "run_xxx",
  "promptTokens": 3500,
  "completionTokens": 420,
  "totalTokens": 3920,
  "data": {
    "name": "杨建涛",
    "gender": null,
    "birth_date": null,
    "country_region": "中国",
    "institution": "上海理工大学",
    "college_department": "健康科学与工程学院",
    "research_areas": ["生物力学", "康复机器人"],
    "research_directions": ["康复机器人", "可穿戴监测设备"],
    "academic_title": "副教授",
    "admin_title": "硕士研究生指导教师",
    "phone": null,
    "email": "yang@example.edu.cn",
    "contact_preferred": "email",
    "bio": "博士毕业于上海交通大学机器人学专业（2020）……",
    "avatar_url": "https://example.edu.cn/faculty/yang.jpg",
    "social_positions": ["中国人工智能学会智能机器人专委会委员"],
    "journal_resources": [
      "《机器人》审稿人",
      "IEEE Transactions on Neural Systems and Rehabilitation Engineering 审稿人"
    ],
    "tags": {
      "academic_honors": [],
      "institution_tier": ["双一流"],
      "experiences": ["有过博士后经历", "参与学术社团"],
      "others": ["导师职务"]
    },
    "_meta": {
      "source_url": "https://www.webofscience.com/wos/author/record/917221",
      "extracted_at": "2026-04-14T08:00:00.000Z"
    }
  },
  "error": null
}
```

业务层通常只关心 5 个字段：

| 字段 | 用途 |
|---|---|
| `success` | 是否拿到了可用数据（true 即可进入左右对比弹窗） |
| `status` | `SUCCEEDED` = 完整，`PARTIAL` = 部分字段缺失但可用 |
| `requestId` | 回写业务流水，用来关联同步记录 |
| `data` | 填充「主页获取值」右栏的 18 个字段 |
| `error` | 失败原因，用来显示「失败」标签 |

其余 `taskId` / `runId` / `*Tokens` 仅用于排障和计费核对，业务端可忽略。

兼容性说明：

- 如果底层抽取结果里这几类字段返回的是业务字典编码值，而不是最终展示文案，业务接口会在返回 `data` 前自动转成标签
- 当前已覆盖的字典字段包括：职称（`professional` / `academic_title`）、研究领域（`domain` / `research_areas`）、头衔（`title`）、国家地区（`country` / `country_region`）

---

## 6. `data` 字段与弹窗 UI 的映射

这是业务方最关心的部分。下表是需求中「主页同步」弹窗右栏 18 个字段与 `data` 的对应关系：

| # | 弹窗字段 | `data` 字段 | 类型 | 说明 |
|---|---|---|---|---|
| 1 | 头像 | `avatar_url` | string \| null | 直接作为 `<img src>` 使用 |
| 2 | 姓名 | `name` | string \| null | 优先中文名 |
| 3 | 性别 | `gender` | `"male"` \| `"female"` \| null | 无明确线索返回 null，业务侧不要猜 |
| 4 | 出生年月 | `birth_date` | string \| null | `YYYY` 或 `YYYY-MM` |
| 5 | 国家地区 | `country_region` | string \| null | 中文国名，如「中国」 |
| 6 | 单位 | `institution` | string \| null | 机构全称 |
| 7 | 学院/部门 | `college_department` | string \| null | 可能是「学院 / 系」拼接 |
| 8 | 研究领域 | `research_areas` | string[] | **数组**，业务侧拼接为逗号分隔展示 |
| 9 | 研究方向 | `research_directions` | string[] | **数组**，同上 |
| 10 | 职称 | `academic_title` | string \| null | 教授/副教授 等 |
| 11 | 职务 | `admin_title` | string \| null | 多个用「; 」拼接 |
| 12 | 联系电话 | `phone` | string \| null | 主页能抓到才有 |
| 13 | 电子邮箱 | `email` | string \| null | 主页能抓到才有 |
| 14 | 惯用联系方式 | `contact_preferred` | string \| null | 很多主页没有，会是 null |
| 15 | 简介 | `bio` | string \| null | ≤300 字中文摘要 |
| 16 | 社会兼职 | `social_positions` | string[] | 学会/协会/委员会兼职，每项是一条字符串 |
| 17 | 期刊资源 | `journal_resources` | string[] | 期刊编委/审稿人/主编等，格式通常是「刊名 + 角色」 |
| 18 | 标签 | `tags` | object | 四个固定分类下的枚举标签，见 6.3 节 |

### 6.3 `tags` 对象结构

`tags` 是一个**四键固定对象**，用于直接渲染弹窗底部「基本信息」区的 checkbox。每个子字段是一个字符串数组，值**只会是下表列出的枚举之一**（不在白名单里的值会被后处理丢弃），没有证据时返回 `[]`。

| 子字段 | UI 分组 | 允许的枚举值 |
|---|---|---|
| `academic_honors` | 职称 | `院士头衔` / `校级` / `处级` / `科协会领导` / `学科带头人` |
| `institution_tier` | 单位层次 | `QS Top 50` / `QS Top 100` / `QS Top 200` / `QS Top 500` / `QS Top 1000` / `985` / `211` / `双一流` / `其它` |
| `experiences` | 经历 | `海归` / `有过博士后经历` / `参与学术社团` / `曾担任学术职务` |
| `others` | 其他 | `顶尖学术奖项` / `导师职务` / `深度培训经历` / `一般培训经历` / `兼办` / `外联` / `院校` |

前端渲染建议：

- 左栏展示专家库当前已勾选的标签，右栏展示 `tags` 里抽到的值，**按枚举值做精确比较**即可
- `tags` 全空时，业务端可以直接把整个「基本信息」区折叠或置为未勾选状态
- **弹窗里的「合作类型」（专业曝光/社交曝光/知识分享）本接口不抽取**，这三项是业务方内部运营标签，由人工维护，不应该从主页推断

### 6.1 null / 空数组的展示建议

- 字段为 `null` 或 `[]` → 右栏显示为空 → 自动变成「不可勾选」状态（等同左栏规则）
- 字段有值 → 右栏显示值 + 可勾选的「采纳该字段」checkbox
- 「一键全选」应只选中「有值且与左栏不一致」的字段

### 6.2 `_meta`

```json
"_meta": {
  "source_url": "本次抽取的主页 URL",
  "extracted_at": "抽取完成的 UTC 时间戳"
}
```

建议业务方把 `_meta` 原样存入主页同步记录，便于事后回溯「这次同步是什么时候从哪个 URL 拿到的」。

---

## 7. 失败响应

### 7.1 抽取失败（主页解析不出来 / 超时）

`success = false`，`data = null`，`error` 非空。

```json
{
  "success": false,
  "status": "FAILED",
  "requestId": "expert-sync-20260414-002",
  "taskId": "task_xxx",
  "runId": "run_xxx",
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

### 7.2 token 错误

```json
{
  "success": false,
  "status": null,
  "requestId": "expert-sync-20260414-003",
  "taskId": null,
  "runId": null,
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

### 7.3 HTTP 状态码

| 状态码 | 含义 | 业务端建议处理 |
|---|---|---|
| `200` | 成功（完整或部分） | 打开左右对比弹窗 |
| `400` | 参数错误（url 缺失等） | 前端提示输入 URL |
| `401` | token 错误 | 检查配置，不要让用户重试 |
| `502` | 主页抽取失败 | 弹窗关闭，展示「失败」状态，允许重试 |
| `504` | 超时 | 同上，`error.retryable = true` 时可自动重试 1 次 |

---

## 8. 端到端示例

假设用户在专家详情页点击「主页同步」，前端把专家主页 URL 传给后端，后端调用：

```bash
curl -X POST http://127.0.0.1:3000/v1/expert-profiles/extract \
  -H 'Authorization: Bearer 49d6209cde82775d7d47995d17ce1a2f2b29b7bcb820b4c540f449ba90a74097' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://health.usst.edu.cn/info/1234/5678.htm",
    "requestId": "expert-sync-10086-20260414"
  }'
```

拿到 `data` 后，业务系统的处理流程：

1. 把本专家详情表查出的当前值拼成「左栏对象」
2. 把 `data` 拼成「右栏对象」（字段名按第 6 节映射）
3. 逐字段比较，渲染左右对比弹窗
4. 用户勾选 / 一键全选 / 完成同步后：
   - 把用户选中的字段更新回专家主库
   - 把本次 `requestId`、`taskId`、`_meta` 存入主页同步记录表，并把状态置为「已同步」
5. 若返回失败：把同步记录状态置为「失败」，`error.message` 存入备注

---

## 9. 对接注意事项

- **同步等待**：本接口是同步接口，典型耗时 10–60 秒，超时 180 秒。建议业务方前端显示「同步中…」loading，后端调用超时至少给到 200 秒
- **并发**：同一专家短时间内重复点击同步，建议业务端用 `requestId` 幂等控制，不要每次都生成新 ID
- **字段缺失是常态**：不同主页数据完整度差异大，`PARTIAL` 是很常见的状态，不要当作错误处理
- **URL 清洗**：建议业务端先去掉 URL 末尾的空格、追踪参数，再传进来
- **不要把 token 塞进前端**：token 只应出现在后端到本服务之间的调用链
