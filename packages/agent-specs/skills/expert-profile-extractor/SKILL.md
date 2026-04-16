---
name: expert-profile-extractor
description: Extract structured expert/faculty profile data from scholar homepages, faculty staff pages, researcher profile URLs, or HTML files. Produces the business API shape directly: avatar, surname, sex, birthday, country, province, city, organization, department, domain, direction, professional, position, phone, email, contact, content, academic, journal, title, tags.
---

# Expert Profile Extractor

把专家主页、教师主页、研究人员目录页抽成**业务接口最终字段**。  
当前 skill 已经不再输出旧的 `name / institution / research_areas` 那套中间结构，而是直接对齐新的 extract API 字段名。

## 适用场景

适用于这类请求：

- “把这个专家主页抽成 JSON”
- “解析这个教授页面”
- “抓取这批老师主页的结构化信息”
- “从这个 URL 提取专家资料”

## 输出结构

返回结构固定为：

```json
{
  "status": 200,
  "data": {
    "avatar": "string | null",
    "surname": "string | null",
    "sex": "0 | 1 | 2",
    "birthday": "YYYY-MM-DD | null",
    "country": "int",
    "province": "int",
    "city": "int",
    "organization": "string | null",
    "department": "string | null",
    "domain": "int",
    "direction": "string | null",
    "professional": "int",
    "position": "string | null",
    "phone": "string | null",
    "email": "string | null",
    "contact": "string | null",
    "content": "string | null",
    "academic": "string | null",
    "journal": "string | null",
    "title": "int",
    "tags": "comma-separated ids | null"
  }
}
```

说明：

- `sex`: `0=未知`，`1=男`，`2=女`
- `country / domain / professional`: 字典 ID
- `title`: 位运算值
- `tags`: 逗号拼接的标签 ID
- `contact`: 只保留 phone / email 之外的其他联系方式

## 使用方式

```bash
.venv/bin/python scripts/extract.py <URL_OR_HTML_PATH> [--out <output.json>]
```

示例：

```bash
# 在线页面
.venv/bin/python scripts/extract.py https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm

# 本地 HTML
.venv/bin/python scripts/extract.py tests/fixtures/usst_yangjiantao.html \
  --source-url https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm

# 批量
.venv/bin/python scripts/extract.py urls.txt --batch --out results.jsonl
```

## 抽取流程

当前链路分为四层：

1. `fetch`
   - 抓网页，支持代理/直连回退。
2. `rules.py`
   - 负责高置信度字段：`email`、`phone`、`avatar`、`surname`、`country`
3. `html_cleaner_opencli.py`
   - 负责主内容抽取和结构化数据预填
   - 直接产出新字段名的预填候选，如 `organization`、`department`、`professional`
4. `llm_client.py + prompt`
   - 对自由文本字段做翻译、归纳、补全
   - 也直接使用新字段名
5. `response_formatter.py`
   - 不再做旧字段改名
   - 只负责把宽松值规范成最终接口需要的 ID / 位运算 / 逗号字符串

## 当前设计原则

- 内部字段名与外部 API 字段名一致，避免多套 schema 并存
- `phone / email / avatar / surname` 优先信规则层
- `organization / department / professional / position / content` 由预填层和 LLM 协同补全
- `country / province / domain / professional / title / tags` 在最后统一做字典映射
- 页面没有证据时宁可留空，也不猜

## 规则说明

- `direction` 对应旧逻辑里的 `research_directions`
- 旧的 `research_areas` 不再直接返回，而是作为 `domain` 的候选证据，并在需要时兜底填到 `direction`
- `tags` 现在直接对接业务标签字典，不再输出旧版四分类对象
- `meta` / `contact_preferred` 已移除，不再出现在 extract 接口响应里

## 测试

快速测试：

```bash
python3 -m unittest \
  tests/test_html_cleaner_opencli.py \
  tests/test_html_cleaner_opencli_structured.py \
  tests/test_skill_logic.py
```

如果页面是强 JS 渲染或被站点拦截，skill 可能只能返回部分字段；这种情况通常需要浏览器渲染或专项适配。
