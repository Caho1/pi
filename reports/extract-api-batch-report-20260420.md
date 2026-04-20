# Extract 接口并发测试报告

## 测试概览

- 生成时间: 2026-04-20 02:14:26 UTC
- 接口地址: `http://127.0.0.1:3000/v1/expert-profiles/extract`
- 并发度: `9`
- 请求总数: `9`
- 成功返回数据: `6`
- 失败/异常: `3`
- 批次总耗时: `180.09s`
- 单请求耗时总和: `654.05s`
- 最长单请求耗时: `180.09s`
- 重叠系数: `3.63`

重叠系数 = 所有请求耗时之和 / 批次总耗时。明显大于 `1.0` 通常说明请求存在并发重叠，而不是串行排队。

## 关键结论

- 并发成立：9 条请求在 `180.09s` 内完成，而单请求耗时总和达到 `654.05s`，说明这批调用不是串行执行。
- 数据完整度最好的是 `赵俊华(17 字段)` 和 `Huosheng Hu(16 字段)`，两者都返回了较完整的机构、方向和简介信息。
- `empty_profile` 出现在 2 个站点：`https://teacher.nwpu.edu.cn/liwenya.html`、`https://www.northumbria.ac.uk/about-us/our-staff/g/fary-ghassemlooy`，这两条目前被接口判定为“抽到了空专家档案”。
- `https://www.cse.cuhk.edu.hk/irwin.king/` 返回 `500`，但错误文案是 `Task finished with status 'RUNNING'`，这更像是控制面超时后把非终态任务直接映射成失败，值得单独排查。

## 汇总表

| # | 站点 | HTTP | 结果 | 耗时(s) | 有效字段数 | 姓名 | 单位 | 邮箱 | 备注 |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| 1 | www.essex.ac.uk | 200 | DATA | 43.79 | 16 | Huosheng Hu | 埃塞克斯大学 | hhu@essex.ac.uk | 固定电话疑似重复拼接 |
| 2 | www.kth.se | 200 | DATA | 35.88 | 6 | Aristides Gionis | - | argioni@kth.se | 核心字段缺失: organization, department, direction, content |
| 3 | avesis.kocaeli.edu.tr | 200 | DATA | 26.85 | 9 | MÜSLÜM ARICI | Kocaeli Üniversitesi | muslumarici@kocaeli.edu.tr | 核心字段缺失: department, direction, content |
| 4 | www.polyu.edu.hk | 200 | DATA | 75.27 | 14 | 薛禹胜教授 | 国家电网电力科学研究院 | - | 核心字段缺失: email |
| 5 | teacher.nwpu.edu.cn | 500 | HTTP_ERROR | 92.41 | 0 | - | - | - | Extractor returned an empty expert profile payload |
| 6 | baike.baidu.com | 200 | DATA | 70.60 | 13 | 高宝玉 | 山东大学 | - | 核心字段缺失: email |
| 7 | www.northumbria.ac.uk | 500 | HTTP_ERROR | 47.73 | 0 | - | - | - | Extractor returned an empty expert profile payload |
| 8 | www.cse.cuhk.edu.hk | 500 | HTTP_ERROR | 180.09 | 0 | - | - | - | Task finished with status 'RUNNING' |
| 9 | sse.cuhk.edu.cn | 200 | DATA | 81.44 | 17 | 赵俊华 | 香港中文大学（深圳） | zhaojunhua@cuhk.edu.cn | 核心字段基本齐全 |

## 逐条结果

### 1. https://www.essex.ac.uk/people/HUHUO40009/Huosheng-Hu

- requestId: `extract-batch-01-1b64787a`
- HTTP 状态: `200`
- 耗时: `43.79s`
- 时间窗: `0.00s -> 43.80s`
- 结果类型: `DATA`
- 判断: 固定电话疑似重复拼接
- 姓名: `Huosheng Hu `
- 单位/部门: `埃塞克斯大学` / `计算机科学与电子工程系`
- 研究方向: `智能系统与自主移动机器人,网络化机器人与网络使能系统/设备,智能传感器/执行器与机电一体化,传感器融合与数据融合算法,远程康复/远程照护/远程医疗,智能轮椅,遗传算法/模糊逻辑/神经网络在机器人中的应用,普适计算/移动计算/eLearni…`
- 联系方式: `email=hhu@essex.ac.uk` `phone=-` `tel=015264-015264`
- 简介摘要: `胡浩生，牛津大学机器人学博士，中南大学工业自动化硕士，现任英国埃塞克斯大学计算机科学与电子工程系教授、博士生导师，机器人研究组成员，长期从事智能系统、自主移动机器人、网络化机器人、智能轮椅、远程医疗及多源传感融合等方向的研究。`
- 学术兼职: `-`
- 期刊资源: `IEEE Transactions on Circuits and Systems,Part 2: Express Briefs,IEEE Transactions on Network Science and Engineering,E…`
- tags: `15,21,73`

### 2. https://www.kth.se/profile/argioni

- requestId: `extract-batch-02-a2c92f6a`
- HTTP 状态: `200`
- 耗时: `35.88s`
- 时间窗: `0.00s -> 35.88s`
- 结果类型: `DATA`
- 判断: 核心字段缺失: organization, department, direction, content
- 姓名: `Aristides Gionis `
- 单位/部门: `-` / `-`
- 研究方向: `-`
- 联系方式: `email=argioni@kth.se` `phone=-` `tel=+46 8 790 60 00`
- 简介摘要: `-`
- 学术兼职: `-`
- 期刊资源: `-`
- tags: `-`

### 3. https://avesis.kocaeli.edu.tr/muslumarici

- requestId: `extract-batch-03-5a5f217a`
- HTTP 状态: `200`
- 耗时: `26.85s`
- 时间窗: `0.00s -> 26.85s`
- 结果类型: `DATA`
- 判断: 核心字段缺失: department, direction, content
- 姓名: `MÜSLÜM ARICI `
- 单位/部门: `Kocaeli Üniversitesi` / `-`
- 研究方向: `-`
- 联系方式: `email=muslumarici@kocaeli.edu.tr` `phone=-` `tel=+90 262 303 3452`
- 简介摘要: `-`
- 学术兼职: `-`
- 期刊资源: `-`
- tags: `-`

### 4. https://www.polyu.edu.hk/rcgm/people/honorable-advisors/prof-xue-yusheng/?sc_lang=sc

- requestId: `extract-batch-04-5a9c4d86`
- HTTP 状态: `200`
- 耗时: `75.27s`
- 时间窗: `0.00s -> 75.27s`
- 结果类型: `DATA`
- 判断: 核心字段缺失: email
- 姓名: `薛禹胜教授 `
- 单位/部门: `国家电网电力科学研究院` / `名誉院长`
- 研究方向: `电力系统暂态稳定性,大停电防御系统,能源网络-物理-社会系统（CPSSE）,能源转型与低碳发展`
- 联系方式: `email=-` `phone=-` `tel=-`
- 简介摘要: `薛禹胜教授于1995年当选为中国工程院院士，现任国家电网电力科学研究院名誉院长，《电力系统自动化》和《Modern Power Systems and Clean Energy（MPCE）》主编，并在浙江大学、东南大学、山东大学、南京航空航天大学担任兼职博士生导师。他在电力系统暂态稳定性定量分析（提出EEAC理论）、…`
- 学术兼职: `-`
- 期刊资源: `《电力系统自动化》主编,《Modern Power Systems and Clean Energy（MPCE）》主编`
- tags: `8,15,21`

### 5. https://teacher.nwpu.edu.cn/liwenya.html

- requestId: `extract-batch-05-fbeca3c6`
- HTTP 状态: `500`
- 耗时: `92.41s`
- 时间窗: `0.00s -> 92.41s`
- 结果类型: `HTTP_ERROR`
- 判断: Extractor returned an empty expert profile payload
- error.stage: `validation`
- error.code: `empty_profile`
- error.message: `Extractor returned an empty expert profile payload`

### 6. https://baike.baidu.com/item/%E9%AB%98%E5%AE%9D%E7%8E%89/1145893

- requestId: `extract-batch-06-bd1df863`
- HTTP 状态: `200`
- 耗时: `70.60s`
- 时间窗: `0.00s -> 70.60s`
- 结果类型: `DATA`
- 判断: 核心字段缺失: email
- 姓名: `高宝玉 `
- 单位/部门: `山东大学` / `环境科学与工程学院`
- 研究方向: `水处理技术,混凝理论与应用,水化学,环境功能材料`
- 联系方式: `email=-` `phone=-` `tel=-`
- 简介摘要: `高宝玉，清华大学环境工程专业工学博士，现任山东大学环境科学与工程学院特聘教授、博士生导师；曾任该学院院长、学术委员会主任、副院长、副系主任等职；长期从事水处理技术、混凝理论与应用、水化学及环境功能材料研究。`
- 学术兼职: `-`
- 期刊资源: `-`
- tags: `2,8,21`

### 7. https://www.northumbria.ac.uk/about-us/our-staff/g/fary-ghassemlooy

- requestId: `extract-batch-07-bd4fdd78`
- HTTP 状态: `500`
- 耗时: `47.73s`
- 时间窗: `0.00s -> 47.73s`
- 结果类型: `HTTP_ERROR`
- 判断: Extractor returned an empty expert profile payload
- error.stage: `validation`
- error.code: `empty_profile`
- error.message: `Extractor returned an empty expert profile payload`

### 8. https://www.cse.cuhk.edu.hk/irwin.king/

- requestId: `extract-batch-08-79114b09`
- HTTP 状态: `500`
- 耗时: `180.09s`
- 时间窗: `0.00s -> 180.09s`
- 结果类型: `HTTP_ERROR`
- 判断: Task finished with status 'RUNNING'
- error.stage: `platform`
- error.code: `task.not_succeeded`
- error.message: `Task finished with status 'RUNNING'`

### 9. https://sse.cuhk.edu.cn/faculty/zhaojunhua

- requestId: `extract-batch-09-0e1abd12`
- HTTP 状态: `200`
- 耗时: `81.44s`
- 时间窗: `0.00s -> 81.44s`
- 结果类型: `DATA`
- 判断: 核心字段基本齐全
- 姓名: `赵俊华 `
- 单位/部门: `香港中文大学（深圳）` / `理工学院 / 电力系`
- 研究方向: `电力系统分析与计算,智能电网,能源经济,低碳转型,人工智能`
- 联系方式: `email=zhaojunhua@cuhk.edu.cn` `phone=-` `tel=-`
- 简介摘要: `赵俊华，工学博士（澳大利亚昆士兰大学），工学学士（西安交通大学），现任香港中文大学（深圳）理工学院教授、中新智慧储能联合研究中心执行主任、深圳高等金融研究院能源市场与能源金融实验室主任、深圳人工智能与机器人研究院研究员；回国前曾任澳大利亚纽卡斯尔大学智能电网研究中心主任科学家，拥有11年澳大利亚电力行业经验；长期从事…`
- 学术兼职: `IEEE Special Interest Group on Active Distribution Grids and Microgrids联合主席,IEEE PES SBLC亚太工作组秘书,国际智能电网联盟（GSGF）专家组成员,《澳…`
- 期刊资源: `IEEE Transactions on Network Science and Engineering编委,Energy Conversion and Economics编委`
- tags: `8,15,17,20,21,73`
