type EnumDictionary = Record<number, string>;
// 业务侧约定的字典标签对象：`value` 是字典编码（命中字典时为数字，未命中为 null），
// `name` 是展示用的中文标签。保留 unknown 是为了让未命中字典的原始输入值也能照常下发。
type DictionaryItem = {
  value: number | null;
  name: unknown;
};

type BusinessTags = {
  position: string[];
  experience: string[];
  other: string[];
};

const PROFESSIONAL_LABELS: EnumDictionary = {
  1: "教授",
  2: "副教授",
  3: "助理教授",
  4: "研究员",
  5: "副研究员",
  6: "助理研究员",
  7: "正高级工程师",
  8: "高级工程师",
  9: "讲师",
  10: "学生",
  11: "其他正高级职称",
  12: "其他高级职称",
};

const DOMAIN_LABELS: EnumDictionary = {
  1: "环境及资源科学技术",
  2: "能源科学",
  3: "化学与化学工程",
  4: "电子与通信技术",
  5: "不限/全学科",
  6: "材料科学",
  7: "计算机科学与技术",
  8: "人工智能",
  9: "经济学",
  10: "社会学",
  11: "交通运输工程",
  12: "矿山工程",
  13: "信息与系统科学相关工程与技术",
  14: "管理学",
  15: "数学",
  16: "地球科学",
  17: "食品科学",
  18: "土木建筑工程",
  19: "水利工程",
  20: "其他学科",
  22: "心理学",
  23: "语言教育艺术体育",
  24: "5",
  25: "6",
  26: "动力与电气工程",
  27: "力学与物理学",
  28: "测绘科学",
  29: "航空航天科学",
  30: "纺织科学",
  31: "安全科学",
  32: "农林畜牧水产",
  33: "机械工程",
  34: "冶金工程",
  35: "生物学与生物工程",
  36: "7",
  37: "天文学",
  38: "民族宗教",
  39: "医学与药学",
  40: "核科学",
  41: "文学历史哲学",
  42: "政治学",
  43: "法学",
  44: "海洋科学",
  45: "光学",
  46: "教育学",
};

const COUNTRY_LABELS: EnumDictionary = {
  1: "中国",
  2: "中国台湾",
  3: "中国香港",
  4: "中国澳门",
  5: "马来西亚",
  6: "新加坡",
  7: "日本",
  8: "韩国",
  9: "美国",
  10: "加拿大",
  11: "澳大利亚",
  12: "新西兰",
  13: "阿尔巴尼亚",
  14: "阿尔及利亚",
  15: "阿富汗",
  16: "阿根廷",
  17: "阿拉伯联合酋长国",
  18: "阿鲁巴",
  19: "阿曼",
  20: "阿塞拜疆",
  21: "埃及",
  22: "埃塞俄比亚",
  23: "爱尔兰",
  24: "爱沙尼亚",
  25: "安道尔",
  26: "安哥拉",
  27: "安圭拉",
  28: "安提瓜和巴布达",
  29: "奥地利",
  30: "巴巴多斯",
  31: "巴布亚新几内亚",
  32: "巴哈马",
  33: "巴基斯坦",
  34: "巴拉圭",
  35: "巴勒斯坦",
  36: "巴林",
  37: "巴拿马",
  38: "巴西",
  39: "白俄罗斯",
  40: "百慕大",
  41: "保加利亚",
  42: "贝宁",
  43: "比利时",
  44: "冰岛",
  45: "波多黎各",
  46: "波兰",
  47: "波斯尼亚和黑塞哥维那",
  48: "玻利维亚",
  49: "伯利兹",
  50: "博茨瓦纳",
  51: "不丹",
  52: "布基纳法索",
  53: "布隆迪",
  54: "朝鲜",
  55: "赤道几内亚",
  56: "丹麦",
  57: "德国",
  58: "东帝汶",
  59: "多哥",
  60: "多米尼加",
  61: "多明尼加共和国",
  62: "俄罗斯",
  63: "厄瓜多尔",
  64: "厄立特里亚",
  65: "法国",
  66: "法罗群岛",
  67: "法属波利尼西亚",
  68: "法属圭亚那",
  69: "菲律宾",
  70: "斐济",
  71: "芬兰",
  72: "佛得角",
  73: "冈比亚",
  74: "刚果共和国",
  75: "刚果民主共和国",
  76: "哥伦比亚",
  77: "哥斯达黎加",
  78: "格林纳达",
  79: "格陵兰",
  80: "格鲁吉亚",
  81: "古巴",
  82: "瓜德罗普岛",
  83: "关岛",
  84: "圭亚那",
  85: "哈萨克斯坦",
  86: "海地",
  87: "荷兰",
  88: "荷属安的列斯群岛",
  89: "黑山",
  90: "洪都拉斯",
  91: "吉布提",
  92: "吉尔吉斯斯坦",
  93: "几内亚",
  94: "几内亚比绍",
  95: "加纳",
  96: "加蓬",
  97: "柬埔寨",
  98: "捷克共和国",
  99: "津巴布韦",
  100: "喀麦隆",
  101: "卡塔尔",
  102: "开曼群岛",
  103: "科摩罗",
  104: "科威特",
  105: "克罗地亚",
  106: "肯尼亚",
  107: "库克群岛",
  108: "拉脱维亚",
  109: "莱索托",
  110: "老挝",
  111: "黎巴嫩",
  112: "立陶宛",
  113: "利比里亚",
  114: "利比亚",
  115: "列支敦士登",
  116: "留尼旺岛",
  117: "卢森堡",
  118: "卢旺达",
  119: "罗马尼亚",
  120: "马达加斯加",
  121: "马尔代夫",
  122: "马耳他",
  123: "马拉维",
  124: "马里",
  125: "马其顿",
  126: "马提尼克",
  127: "毛里求斯",
  128: "毛里塔尼亚",
  129: "蒙古",
  130: "蒙特塞拉特",
  131: "孟加拉",
  132: "秘鲁",
  133: "摩尔多瓦",
  134: "摩洛哥",
  135: "摩纳哥",
  136: "莫桑比克",
  137: "墨西哥",
  138: "纳米比亚",
  139: "南非",
  140: "南苏丹",
  141: "尼泊尔",
  142: "尼加拉瓜",
  143: "尼日尔",
  144: "尼日利亚",
  145: "挪威",
  146: "葡萄牙",
  147: "瑞典",
  148: "瑞士",
  149: "萨尔瓦多",
  150: "萨摩亚",
  151: "塞尔维亚",
  152: "塞拉利昂",
  153: "塞内加尔",
  154: "塞浦路斯",
  155: "塞舌尔",
  156: "沙特阿拉伯",
  157: "圣多美和普林西比",
  158: "圣基茨和尼维斯",
  159: "圣卢西亚",
  160: "圣马力诺",
  161: "圣皮埃尔和密克隆群岛",
  162: "圣文森特和格林纳丁斯",
  163: "斯里兰卡",
  164: "斯洛伐克",
  165: "斯洛文尼亚",
  166: "斯威士兰",
  167: "苏丹",
  168: "苏里南",
  169: "索马里",
  170: "塔吉克斯坦",
  171: "泰国",
  172: "坦桑尼亚",
  173: "汤加",
  174: "特克斯和凯科斯群岛",
  175: "特里尼达和多巴哥",
  176: "突尼斯",
  177: "土耳其",
  178: "土库曼斯坦",
  179: "瓦努阿图",
  180: "危地马拉",
  181: "委内瑞拉",
  182: "文莱",
  183: "乌干达",
  184: "乌克兰",
  185: "乌拉圭",
  186: "乌兹别克斯坦",
  187: "西班牙",
  188: "希腊",
  189: "象牙海岸",
  190: "新喀里多尼亚",
  191: "匈牙利",
  192: "叙利亚",
  193: "牙买加",
  194: "亚美尼亚",
  195: "也门",
  196: "伊拉克",
  197: "伊朗",
  198: "以色列",
  199: "意大利",
  200: "印度",
  201: "印尼",
  202: "英国",
  203: "英属维尔京群岛",
  204: "约旦",
  205: "越南",
  206: "赞比亚",
  207: "泽西岛",
  208: "乍得",
  209: "直布罗陀",
  210: "智利",
  211: "中非共和国",
  212: "科索沃",
};

const TITLE_FLAGS = [
  { flag: 1, label: "院士" },
  { flag: 2, label: "国家级高层次人才" },
  { flag: 4, label: "国家级青年人才" },
  { flag: 8, label: "IEEE Fellow" },
  { flag: 16, label: "ACM Fellow" },
  { flag: 32, label: "IEEE高级会员" },
  { flag: 64, label: "ACM高级会员" },
  { flag: 128, label: "IEEE 会员" },
  { flag: 256, label: "ACM 会员" },
] as const;

const TITLE_LABELS: EnumDictionary = Object.fromEntries(TITLE_FLAGS.map(({ flag, label }) => [flag, label]));

const TAG_ID_TO_LABEL: Record<number, string> = {
  1: "校级领导", 2: "院所领导", 3: "处级领导", 4: "学协会领导", 5: "学科带头人",
  6: "QS Top 200", 7: "QS Top 500", 8: "双一流高校", 9: "985高校",
  10: "本科院校", 11: "专科院校", 12: "公办", 13: "民办", 14: "合作办学",
  15: "期刊任职", 16: "学术会议组织经验", 17: "学术评审经验", 18: "审修经历",
  19: "学术文章原创经验", 20: "顶级学术机构", 21: "导师师资",
  22: "深度话题创作", 23: "一般话题创作", 24: "专业曝光", 25: "社交拓展",
  26: "知识分享", 27: "期刊审稿", 28: "同行预审", 29: "翻译", 30: "润色",
  31: "审修", 32: "降重", 33: "头条创作", 34: "提案", 35: "会议嘉宾",
  36: "艾思云课堂", 37: "论文一对一", 38: "其它", 39: "会议组委审稿",
  40: "专家审稿", 41: "校对", 42: "排版", 43: "图表编辑", 44: "合作办会",
  45: "经费筹集", 46: "专家推荐", 47: "场地申请", 48: "合作引荐",
  49: "宣传组织", 50: "会务筹备", 51: "志愿者组织", 52: "参会推荐",
  53: "投稿推荐", 54: "出版配合", 55: "翻译水平高", 56: "润色水平高",
  57: "合作意愿强", 58: "配合程度高", 59: "有亲和力", 60: "学术资源丰富",
  61: "时间观念强", 62: "任务质量高", 63: "学术水平高", 64: "翻译水平低",
  65: "润色水平低", 66: "合作意愿弱", 67: "配合程度低", 68: "不好相处",
  69: "学术资源欠缺", 70: "时间观念差", 71: "任务质量低", 72: "学术水平低",
  73: "海外院校", 74: "终止合作", 75: "审批文件",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDictionaryItem(value: unknown): value is DictionaryItem {
  return isPlainObject(value) && "value" in value && "name" in value;
}

function parseNumericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return undefined;
}

function findEnumKeyByLabel(value: string, dictionary: EnumDictionary): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  for (const [rawKey, label] of Object.entries(dictionary)) {
    if (label === normalized) {
      return Number(rawKey);
    }
  }

  return undefined;
}

function toScalarDictionaryItem(value: unknown, dictionary: EnumDictionary): DictionaryItem | unknown {
  if (value === null || value === undefined || value === "") {
    return value;
  }

  if (isDictionaryItem(value)) {
    return value;
  }

  const numericValue = parseNumericValue(value);
  if (numericValue !== undefined) {
    return {
      value: numericValue,
      name: dictionary[numericValue] ?? value,
    };
  }

  if (typeof value === "string") {
    const matchedKey = findEnumKeyByLabel(value, dictionary);
    if (matchedKey !== undefined) {
      return {
        value: matchedKey,
        name: dictionary[matchedKey],
      };
    }
  }

  return {
    value: null,
    name: value,
  };
}

function toDictionaryItemList(value: unknown, dictionary: EnumDictionary): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isDictionaryItem(item) ? item : toScalarDictionaryItem(item, dictionary)));
  }

  const translated = toScalarDictionaryItem(value, dictionary);
  return translated === value ? value : [translated];
}

function translateBitmask(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isDictionaryItem(item) ? item : toScalarDictionaryItem(item, TITLE_LABELS)));
  }

  if (isDictionaryItem(value)) {
    return [value];
  }

  const numericValue = parseNumericValue(value);
  if (numericValue !== undefined) {
    const translated = TITLE_FLAGS.filter(({ flag }) => (numericValue & flag) === flag).map(({ flag, label }) => ({
      value: flag,
      name: label,
    }));

    if (translated.length > 0 || numericValue === 0) {
      return translated;
    }

    return [
      {
        value: numericValue,
        name: value,
      },
    ];
  }

  if (typeof value === "string") {
    const matchedKey = findEnumKeyByLabel(value, TITLE_LABELS);
    if (matchedKey !== undefined) {
      return [
        {
          value: matchedKey,
          name: TITLE_LABELS[matchedKey],
        },
      ];
    }
  }

  return [
    {
      value: null,
      name: value,
    },
  ];
}

function firstPresent(structured: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (!(key in structured)) {
      continue;
    }
    const value = structured[key];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    return value;
  }
  return undefined;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toStringList(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\n，；、]+/g)
      : [];
  if (!Array.isArray(rawValues)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of rawValues) {
    if (typeof item !== "string") {
      continue;
    }
    const cleaned = item.trim();
    if (!cleaned) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    normalized.push(cleaned);
  }
  return normalized;
}

function toNullableScalarDictionaryItem(value: unknown, dictionary: EnumDictionary): DictionaryItem | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return toScalarDictionaryItem(value, dictionary) as DictionaryItem;
}

function toDictionaryItemArray(value: unknown, dictionary: EnumDictionary): DictionaryItem[] {
  if (value === null || value === undefined || value === "") {
    return [];
  }
  const translated = toDictionaryItemList(value, dictionary);
  return Array.isArray(translated) ? (translated as DictionaryItem[]) : [];
}

function toTitleArray(value: unknown): DictionaryItem[] {
  if (value === null || value === undefined || value === "") {
    return [];
  }
  const translated = translateBitmask(value);
  return Array.isArray(translated) ? (translated as DictionaryItem[]) : [];
}

function translateSex(value: unknown): string | null {
  if (value === 1 || value === "1" || value === "male") return "男";
  if (value === 2 || value === "2" || value === "female") return "女";
  if (value === 0 || value === "0") return null;
  return toNullableString(value);
}

function normalizeTags(value: unknown): BusinessTags {
  const empty: BusinessTags = { position: [], experience: [], other: [] };

  if (!isPlainObject(value)) {
    // 新 schema：逗号拼接的数字 ID 串，如 "5,8,21"
    if (typeof value === "string" && value.trim()) {
      const labels = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const id = Number(s);
          return Number.isInteger(id) && id > 0 ? (TAG_ID_TO_LABEL[id] ?? null) : s;
        })
        .filter((s): s is string => s !== null && s.length > 0);
      return { position: [], experience: [], other: labels };
    }
    return empty;
  }

  // 旧 schema：{academic_honors, institution_tier, experiences, others} 对象
  const position = toStringList(firstPresent(value, ["position", "academic_honors"]));
  const experience = toStringList(firstPresent(value, ["experience", "experiences"]));
  const other = toStringList([
    ...toStringList(firstPresent(value, ["other"])),
    ...toStringList(firstPresent(value, ["institution_tier"])),
    ...toStringList(firstPresent(value, ["others"])),
  ]);

  return { position, experience, other };
}

export function translateExpertProfileBusinessStructured(structured: unknown): unknown {
  if (!isPlainObject(structured)) {
    return structured;
  }

  // 业务接口对外暴露的是数字化系统约定的字段名，不把底层 skill 的历史命名
  // （academic_title / research_areas / avatar_url 等）直接透传给上游。
  return {
    avatar: toNullableString(firstPresent(structured, ["avatar", "avatar_url"])),
    name: toNullableString(firstPresent(structured, ["surname", "name"])),
    sex: translateSex(firstPresent(structured, ["sex", "gender"])),
    birthday: toNullableString(firstPresent(structured, ["birthday", "birth_date"])),
    country: toNullableScalarDictionaryItem(firstPresent(structured, ["country", "country_region"]), COUNTRY_LABELS),
    organization: toNullableString(firstPresent(structured, ["organization", "institution"])),
    department: toNullableString(firstPresent(structured, ["department", "college_department"])),
    domain: toDictionaryItemArray(firstPresent(structured, ["domain", "research_areas"]), DOMAIN_LABELS),
    direction: toStringList(firstPresent(structured, ["direction", "research_directions"])),
    professional: toNullableScalarDictionaryItem(firstPresent(structured, ["professional", "academic_title"]), PROFESSIONAL_LABELS),
    position: toNullableString(firstPresent(structured, ["position", "admin_title"])),
    phone: toNullableString(firstPresent(structured, ["phone"])),
    email: toNullableString(firstPresent(structured, ["email"])),
    // `contact` 只表示 phone / email 之外的备用联系方式，不允许用
    // `contact_preferred`（邮箱/电话偏好）来兜底，否则会误导业务侧。
    contact: toNullableString(firstPresent(structured, ["contact"])),
    bio: toNullableString(firstPresent(structured, ["bio", "introduction", "intro", "content"])),
    academic: toStringList(firstPresent(structured, ["academic", "social_positions"])),
    journal: toStringList(firstPresent(structured, ["journal", "journal_resources"])),
    title: toTitleArray(firstPresent(structured, ["title"])),
    tags: normalizeTags(firstPresent(structured, ["tags"])),
  };
}
