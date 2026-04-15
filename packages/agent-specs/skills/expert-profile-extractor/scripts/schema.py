"""Pydantic model for the expert profile output."""
from __future__ import annotations

from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class ProfileMeta(BaseModel):
    source_url: str
    extracted_at: str
    fields_from_rule: List[str] = Field(default_factory=list)
    fields_from_llm: List[str] = Field(default_factory=list)
    fields_missing: List[str] = Field(default_factory=list)


class ExpertTags(BaseModel):
    """Business-side tag taxonomy used by the 专家主页同步 popup.

    Values are restricted to the predefined checkbox options. The LLM may
    return an empty list for any category when there is no textual evidence
    on the page.
    """

    # 职称: 院士头衔 / 校级 / 处级 / 科协会领导 / 学科带头人
    academic_honors: List[str] = Field(default_factory=list)
    # 单位层次: QS Top 50 / 100 / 200 / 500 / 1000 / 985 / 211 / 双一流 / 其它
    institution_tier: List[str] = Field(default_factory=list)
    # 经历: 海归 / 有过博士后经历 / 参与学术社团 / 曾担任学术职务
    experiences: List[str] = Field(default_factory=list)
    # 其它: 顶尖学术奖项 / 导师职务 / 深度培训经历 / 一般培训经历 / 兼办 / 外联 / 院校
    others: List[str] = Field(default_factory=list)


class ExpertProfile(BaseModel):
    name: Optional[str] = None
    gender: Optional[Literal["male", "female"]] = None
    birth_date: Optional[str] = None
    country_region: Optional[str] = None
    institution: Optional[str] = None
    college_department: Optional[str] = None
    research_areas: List[str] = Field(default_factory=list)
    research_directions: List[str] = Field(default_factory=list)
    academic_title: Optional[str] = None
    admin_title: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    contact: Optional[str] = None
    contact_preferred: Optional[Literal["email", "phone", "other"]] = None
    bio: Optional[str] = None
    avatar_url: Optional[str] = None
    social_positions: List[str] = Field(default_factory=list)
    journal_resources: List[str] = Field(default_factory=list)
    title: List[str] = Field(default_factory=list)
    tags: ExpertTags = Field(default_factory=ExpertTags)
    meta: ProfileMeta = Field(alias="_meta")

    class Config:
        populate_by_name = True


# Field names that LLM is expected to return (excludes derived and meta)
LLM_FIELDS = [
    "name",
    "gender",
    "birth_date",
    "country_region",
    "institution",
    "college_department",
    "research_areas",
    "research_directions",
    "academic_title",
    "admin_title",
    "bio",
    "contact",
    "social_positions",
    "journal_resources",
    "title",
    "tags",
]

# Fields the rule layer populates
RULE_FIELDS = ["email", "phone", "avatar_url", "name", "country_region"]

# Fields whose natural "empty" value is [] instead of None
LIST_FIELDS = (
    "research_areas",
    "research_directions",
    "social_positions",
    "journal_resources",
    "title",
)

# Object-valued LLM fields (not None, not [])
OBJECT_FIELDS = ("tags",)

# Allowed tag enum values (business-side fixed taxonomy)
TAG_ENUMS = {
    "academic_honors": ["院士头衔", "校级", "处级", "科协会领导", "学科带头人"],
    "institution_tier": [
        "QS Top 50",
        "QS Top 100",
        "QS Top 200",
        "QS Top 500",
        "QS Top 1000",
        "985",
        "211",
        "双一流",
        "其它",
    ],
    "experiences": ["海归", "有过博士后经历", "参与学术社团", "曾担任学术职务"],
    "others": [
        "顶尖学术奖项",
        "导师职务",
        "深度培训经历",
        "一般培训经历",
        "兼办",
        "外联",
        "院校",
    ],
}

ALL_FIELDS = [
    "name", "gender", "birth_date", "country_region", "institution",
    "college_department", "research_areas", "research_directions",
    "academic_title", "admin_title", "phone", "email",
    "contact", "contact_preferred", "bio", "avatar_url",
    "social_positions", "journal_resources", "title", "tags",
]


def empty_tags() -> dict:
    """Return the canonical empty shape for the `tags` field."""
    return {key: [] for key in TAG_ENUMS.keys()}


def sanitize_tags(raw: object) -> dict:
    """Coerce an LLM-produced `tags` value into the strict enum-constrained shape.

    Unknown keys are dropped. Unknown values inside a known category are
    dropped. Duplicates are collapsed while preserving order.
    """
    result = empty_tags()
    if not isinstance(raw, dict):
        return result
    for category, allowed in TAG_ENUMS.items():
        values = raw.get(category)
        if not isinstance(values, list):
            continue
        seen: set[str] = set()
        kept: list[str] = []
        allowed_set = set(allowed)
        for v in values:
            if not isinstance(v, str):
                continue
            cleaned = v.strip()
            if cleaned in allowed_set and cleaned not in seen:
                kept.append(cleaned)
                seen.add(cleaned)
        result[category] = kept
    return result


def is_empty_tags(value: object) -> bool:
    if not isinstance(value, dict):
        return True
    return all(not value.get(k) for k in TAG_ENUMS.keys())
