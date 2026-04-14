"""Pydantic model for the 15-field expert profile output."""
from __future__ import annotations

from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class ProfileMeta(BaseModel):
    source_url: str
    extracted_at: str
    fields_from_rule: List[str] = Field(default_factory=list)
    fields_from_llm: List[str] = Field(default_factory=list)
    fields_missing: List[str] = Field(default_factory=list)


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
    contact_preferred: Optional[Literal["email", "phone", "other"]] = None
    bio: Optional[str] = None
    avatar_url: Optional[str] = None
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
]

# Fields the rule layer populates
RULE_FIELDS = ["email", "phone", "avatar_url", "name", "country_region"]

ALL_FIELDS = [
    "name", "gender", "birth_date", "country_region", "institution",
    "college_department", "research_areas", "research_directions",
    "academic_title", "admin_title", "phone", "email",
    "contact_preferred", "bio", "avatar_url",
]
