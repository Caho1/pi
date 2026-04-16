"""规范化 expert-profile 最终输出。

现在抽取链路内部已经统一使用新的 API 字段名，这个模块不再做“旧字段名 -> 新字段名”
的转换，而是负责两类收口工作：

1. 把 LLM / 预填 / 规则层返回的宽松值（字符串、列表、旧兼容对象）规范成最终类型；
2. 把需要字典映射的字段压成业务侧需要的 ID / 位运算 / 逗号拼接字符串。
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional

import dict_search


_CSV_SPLIT_RE = re.compile(r"[;,；，、\n]+")
_PHONE_RE = re.compile(r"\+?\d[\d()\-\s]{6,}\d")
_EMAIL_RE = re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+", re.IGNORECASE)

_SEX_MAP = {
    "male": 1,
    "man": 1,
    "m": 1,
    "男": 1,
    "female": 2,
    "woman": 2,
    "f": 2,
    "女": 2,
}

_PROVINCE_KEYWORDS: dict[str, int] = {
    "北京市": 1,
    "北京": 1,
    "天津市": 2,
    "天津": 2,
    "河北省": 3,
    "河北": 3,
    "山西省": 4,
    "山西": 4,
    "内蒙古自治区": 5,
    "内蒙古": 5,
    "辽宁省": 6,
    "辽宁": 6,
    "吉林省": 7,
    "吉林": 7,
    "黑龙江省": 8,
    "黑龙江": 8,
    "上海市": 9,
    "上海": 9,
    "江苏省": 10,
    "江苏": 10,
    "浙江省": 11,
    "浙江": 11,
    "安徽省": 12,
    "安徽": 12,
    "福建省": 13,
    "福建": 13,
    "江西省": 14,
    "江西": 14,
    "山东省": 15,
    "山东": 15,
    "河南省": 16,
    "河南": 16,
    "湖北省": 17,
    "湖北": 17,
    "湖南省": 18,
    "湖南": 18,
    "广东省": 19,
    "广东": 19,
    "广西壮族自治区": 20,
    "广西": 20,
    "海南省": 21,
    "海南": 21,
    "重庆市": 22,
    "重庆": 22,
    "四川省": 23,
    "四川": 23,
    "贵州省": 24,
    "贵州": 24,
    "云南省": 25,
    "云南": 25,
    "西藏自治区": 26,
    "西藏": 26,
    "陕西省": 27,
    "陕西": 27,
    "甘肃省": 28,
    "甘肃": 28,
    "青海省": 29,
    "青海": 29,
    "宁夏回族自治区": 30,
    "宁夏": 30,
    "新疆维吾尔自治区": 31,
    "新疆": 31,
}

_CITY_TO_PROVINCE: dict[str, int] = {
    "哈尔滨": 8,
    "大庆": 8,
    "长春": 7,
    "延边": 7,
    "沈阳": 6,
    "大连": 6,
    "呼和浩特": 5,
    "包头": 5,
    "太原": 4,
    "石家庄": 3,
    "保定": 3,
    "秦皇岛": 3,
    "南京": 10,
    "苏州": 10,
    "无锡": 10,
    "南通": 10,
    "徐州": 10,
    "杭州": 11,
    "宁波": 11,
    "温州": 11,
    "合肥": 12,
    "芜湖": 12,
    "厦门": 13,
    "福州": 13,
    "南昌": 14,
    "济南": 15,
    "青岛": 15,
    "烟台": 15,
    "郑州": 16,
    "洛阳": 16,
    "武汉": 17,
    "宜昌": 17,
    "长沙": 18,
    "湘潭": 18,
    "广州": 19,
    "深圳": 19,
    "珠海": 19,
    "东莞": 19,
    "佛山": 19,
    "汕头": 19,
    "中山": 19,
    "南宁": 20,
    "桂林": 20,
    "海口": 21,
    "三亚": 21,
    "成都": 23,
    "绵阳": 23,
    "贵阳": 24,
    "昆明": 25,
    "拉萨": 26,
    "西安": 27,
    "咸阳": 27,
    "兰州": 28,
    "西宁": 29,
    "银川": 30,
    "乌鲁木齐": 31,
}

_TAG_LABEL_TO_ID: dict[str, int] = {
    "校级领导": 1,
    "院所领导": 2,
    "处级领导": 3,
    "学协会领导": 4,
    "学科带头人": 5,
    "QS Top 200": 6,
    "QS Top 500": 7,
    "双一流高校": 8,
    "985高校": 9,
    "本科院校": 10,
    "专科院校": 11,
    "公办": 12,
    "民办": 13,
    "合作办学": 14,
    "期刊任职": 15,
    "学术会议组织经验": 16,
    "学术评审经验": 17,
    "审修经历": 18,
    "学术文章原创经验": 19,
    "顶级学术机构": 20,
    "导师师资": 21,
    "深度话题创作": 22,
    "一般话题创作": 23,
    "专业曝光": 24,
    "社交拓展": 25,
    "知识分享": 26,
    "期刊审稿": 27,
    "同行预审": 28,
    "翻译": 29,
    "润色": 30,
    "审修": 31,
    "降重": 32,
    "头条创作": 33,
    "提案": 34,
    "会议嘉宾": 35,
    "艾思云课堂": 36,
    "论文一对一": 37,
    "论文—对一": 37,
    "其它": 38,
    "会议组委审稿": 39,
    "专家审稿": 40,
    "校对": 41,
    "排版": 42,
    "图表编辑": 43,
    "合作办会": 44,
    "经费筹集": 45,
    "专家推荐": 46,
    "场地申请": 47,
    "合作引荐": 48,
    "宣传组织": 49,
    "会务筹备": 50,
    "志愿者组织": 51,
    "参会推荐": 52,
    "投稿推荐": 53,
    "出版配合": 54,
    "翻译水平高": 55,
    "润色水平高": 56,
    "合作意愿强": 57,
    "配合程度高": 58,
    "有亲和力": 59,
    "学术资源丰富": 60,
    "时间观念强": 61,
    "任务质量高": 62,
    "学术水平高": 63,
    "翻译水平低": 64,
    "润色水平低": 65,
    "合作意愿弱": 66,
    "配合程度低": 67,
    "不好相处": 68,
    "学术资源欠缺": 69,
    "时间观念差": 70,
    "任务质量低": 71,
    "学术水平低": 72,
    "海外院校": 73,
    "终止合作": 74,
    "审批文件": 75,
}

# 兼容旧版四分类 tags，方便迁移期已有测试夹具和 LLM 返回值继续落到新 tags id。
_LEGACY_TAG_VALUE_TO_IDS: dict[str, list[int]] = {
    "校级": [1],
    "处级": [3],
    "科协会领导": [4],
    "学科带头人": [5],
    "QS Top 50": [6],
    "QS Top 100": [6],
    "QS Top 200": [6],
    "QS Top 500": [7],
    "985": [9],
    "211": [9],
    "双一流": [8],
    "海归": [73],
    "曾担任学术职务": [16],
    "导师职务": [21],
}


def _to_int(raw: object, *, minimum: int = 0) -> Optional[int]:
    """把宽松输入安全地转成 int。

    这里特意只接受纯数字字符串，避免把 "Professor 2" 这类脏文本误当成编码。
    """
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw >= minimum else None
    if isinstance(raw, float) and raw.is_integer():
        value = int(raw)
        return value if value >= minimum else None
    if isinstance(raw, str) and raw.strip().isdigit():
        value = int(raw.strip())
        return value if value >= minimum else None
    return None


def _split_tokens(raw: object) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [part.strip() for part in _CSV_SPLIT_RE.split(raw) if part.strip()]
        return parts if parts else ([raw.strip()] if raw.strip() else [])
    if isinstance(raw, (list, tuple, set)):
        items: list[str] = []
        for item in raw:
            items.extend(_split_tokens(item))
        return items
    if isinstance(raw, dict):
        items: list[str] = []
        for value in raw.values():
            items.extend(_split_tokens(value))
        return items
    return [str(raw).strip()] if str(raw).strip() else []


def _deduplicate(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = re.sub(r"\s+", " ", value).strip(" ,;；，、")
        if not cleaned:
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        result.append(cleaned)
    return result


def _map_sex(raw: object) -> int:
    numeric = _to_int(raw, minimum=0)
    if numeric in {0, 1, 2}:
        return numeric
    if isinstance(raw, str):
        return _SEX_MAP.get(raw.strip().lower(), 0)
    return 0


def _map_birthday(raw: object) -> Optional[str]:
    """把生日统一落成 yyyy-mm-dd。

    模型有时只能抽到年份或年月，这里统一补 `01`，确保接口字段始终稳定。
    """
    if raw is None:
        return None
    value = str(raw).strip()
    if not value:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value
    if re.fullmatch(r"\d{4}-\d{2}", value):
        return f"{value}-01"
    if re.fullmatch(r"\d{4}", value):
        return f"{value}-01-01"
    return None


def _lookup_id(dictionary: str, raw: object) -> int:
    numeric = _to_int(raw, minimum=0)
    if numeric is not None:
        return numeric
    for token in _split_tokens(raw):
        result = dict_search.lookup(dictionary, token)
        if result:
            return result["value"]
    return 0


def _province_from_text(text: str) -> int:
    for keyword in sorted(_PROVINCE_KEYWORDS, key=len, reverse=True):
        if keyword in text:
            return _PROVINCE_KEYWORDS[keyword]
    for city, province_id in _CITY_TO_PROVINCE.items():
        if city in text:
            return province_id
    return 0


def _map_province(raw: object, *fallback_texts: object) -> int:
    numeric = _to_int(raw, minimum=0)
    if numeric is not None:
        return numeric
    for token in _split_tokens(raw):
        province_id = _province_from_text(token)
        if province_id:
            return province_id
    for text in fallback_texts:
        if isinstance(text, str) and text.strip():
            province_id = _province_from_text(text)
            if province_id:
                return province_id
    return 0


def _map_domain(raw: object, *, fallback: object = None) -> int:
    numeric = _to_int(raw, minimum=0)
    if numeric is not None:
        return numeric
    for token in _split_tokens(raw):
        result = dict_search.lookup("domains", token)
        if result:
            return result["value"]
    for token in _split_tokens(fallback):
        result = dict_search.lookup("domains", token)
        if result:
            return result["value"]
    return 0


def _map_professional(raw: object) -> int:
    numeric = _to_int(raw, minimum=0)
    if numeric is not None:
        return numeric
    for token in _split_tokens(raw):
        result = dict_search.lookup("academic_titles", token)
        if result:
            return result["value"]
    return 0


def _join_or_none(raw: object) -> Optional[str]:
    if isinstance(raw, str):
        cleaned = raw.strip()
        return cleaned or None
    values = _deduplicate(_split_tokens(raw))
    if not values:
        return None
    return ",".join(values)


def _strip_main_contacts(raw: object) -> Optional[str]:
    """`contact` 只保留 phone / email 之外的备用联系方式。"""
    values = _deduplicate(_split_tokens(raw))
    if not values:
        return None
    kept: list[str] = []
    for value in values:
        without_email = _EMAIL_RE.sub("", value)
        without_phone = _PHONE_RE.sub("", without_email)
        cleaned = re.sub(r"\s+", " ", without_phone).strip(" ,;；，、")
        if cleaned:
            kept.append(cleaned)
    deduped = _deduplicate(kept)
    return ",".join(deduped) if deduped else None


def _map_title(raw: object) -> int:
    numeric = _to_int(raw, minimum=0)
    if numeric is not None:
        return numeric
    bitmask = 0
    for token in _deduplicate(_split_tokens(raw)):
        result = dict_search.lookup("title_flags", token)
        if result:
            bitmask |= result["value"]
    return bitmask


def _map_tags(raw: object) -> Optional[str]:
    tag_ids: list[int] = []
    seen: set[int] = set()

    def add_tag(tag_id: int) -> None:
        if tag_id <= 0 or tag_id in seen:
            return
        seen.add(tag_id)
        tag_ids.append(tag_id)

    if isinstance(raw, dict):
        for values in raw.values():
            for token in _split_tokens(values):
                for tag_id in _LEGACY_TAG_VALUE_TO_IDS.get(token, []):
                    add_tag(tag_id)
                mapped = _TAG_LABEL_TO_ID.get(token)
                if mapped:
                    add_tag(mapped)
    else:
        for token in _split_tokens(raw):
            numeric = _to_int(token, minimum=1)
            if numeric is not None:
                add_tag(numeric)
                continue
            mapped = _TAG_LABEL_TO_ID.get(token)
            if mapped:
                add_tag(mapped)

    if not tag_ids:
        return None
    return ",".join(str(tag_id) for tag_id in tag_ids)


def normalize_profile(profile: dict[str, Any]) -> dict[str, Any]:
    """把抽取链路的宽松结果收口成最终 API 结构。

    这里保留了少量“智能兜底”：
    - `province` 会优先吃显式值，缺失时再从机构/部门/联系方式推断；
    - `domain` 会优先吃显式学科，再从 `direction` 文本补推；
    - `contact` 会主动剔除 email / phone，避免三份字段重复。
    """
    organization = profile.get("organization")
    department = profile.get("department")
    direction = _join_or_none(profile.get("direction"))
    academic = _join_or_none(profile.get("academic"))
    journal = _join_or_none(profile.get("journal"))

    return {
        "avatar": profile.get("avatar"),
        "surname": profile.get("surname"),
        "sex": _map_sex(profile.get("sex")),
        "birthday": _map_birthday(profile.get("birthday")),
        "country": _lookup_id("countries", profile.get("country")),
        "province": _map_province(
            profile.get("province"),
            organization,
            department,
            profile.get("contact"),
        ),
        "city": _to_int(profile.get("city"), minimum=0) or 0,
        "organization": organization,
        "department": department,
        "domain": _map_domain(profile.get("domain"), fallback=direction),
        "direction": direction,
        "professional": _map_professional(profile.get("professional")),
        "position": profile.get("position"),
        "phone": profile.get("phone"),
        "email": profile.get("email"),
        "contact": _strip_main_contacts(profile.get("contact")),
        "content": profile.get("content"),
        "academic": academic,
        "journal": journal,
        "title": _map_title(profile.get("title")),
        "tags": _map_tags(profile.get("tags")),
    }


def format_response(profile: dict[str, Any]) -> dict[str, Any]:
    try:
        return {"status": 200, "data": normalize_profile(profile)}
    except Exception:
        return {"status": 500, "data": None}
