"""Expert-profile 输出模型与字段常量。

这里定义的是 skill 对外要返回的最终字段名，同时也作为抽取链路内部的统一命名。
之所以把旧字段名彻底移除，是为了避免 schema、prompt、rules、merge 各层来回做
“name -> surname / institution -> organization” 这种机械转换，降低维护成本。
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class ExpertProfile(BaseModel):
    avatar: Optional[str] = None
    surname: Optional[str] = None
    sex: int = 0
    birthday: Optional[str] = None
    country: int = 0
    countryCode: Optional[int] = None
    province: int = 0
    city: int = 0
    organization: Optional[str] = None
    department: Optional[str] = None
    domain: int = 0
    direction: Optional[str] = None
    professional: int = 0
    position: Optional[str] = None
    phone: Optional[str] = None
    tel: Optional[str] = None
    email: Optional[str] = None
    contact: Optional[str] = None
    content: Optional[str] = None
    academic: Optional[str] = None
    journal: Optional[str] = None
    title: int = 0
    tags: Optional[str] = None


# LLM 返回的新字段名。这里允许模型返回“可再规范化”的原始值，比如：
# - `country`: 中国 / USA / 9
# - `domain`: 人工智能 / AI / 8
# - `title`: "IEEE Fellow, 杰青" 或 ["IEEE Fellow", "杰青"]
# - `tags`: "QS Top 200, 导师师资" / ["QS Top 200", "导师师资"]
LLM_FIELDS = [
    "surname",
    "sex",
    "birthday",
    "country",
    "province",
    "organization",
    "department",
    "domain",
    "direction",
    "professional",
    "position",
    "contact",
    "content",
    "academic",
    "journal",
    "title",
    "tags",
]

# 规则层负责的高置信度字段。
RULE_FIELDS = ["email", "phone", "tel", "avatar", "surname", "country"]

# 这些字段在 merge 阶段允许临时使用 list 作为“原始表达”，之后再由规范化层
# 统一压成最终 API 需要的逗号字符串或位运算值。
LIST_FIELDS = (
    "direction",
    "academic",
    "journal",
    "title",
)

# `tags` 在 merge 阶段可能来自 list / dict / 逗号字符串，先按 object/容器处理，
# 最后再统一映射成逗号拼接的 tag id 字符串。
OBJECT_FIELDS = ("tags",)

ALL_FIELDS = [
    "avatar",
    "surname",
    "sex",
    "birthday",
    "country",
    "countryCode",
    "province",
    "city",
    "organization",
    "department",
    "domain",
    "direction",
    "professional",
    "position",
    "phone",
    "tel",
    "email",
    "contact",
    "content",
    "academic",
    "journal",
    "title",
    "tags",
]
