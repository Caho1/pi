# 最近 30 个任务 Token 消耗总结

## 概览

- 统计范围: 最近 `30` 个任务（按 `createdAt` 倒序）
- 成功提取到 token usage 的任务数: `30`
- 缺少 trace/usage 的任务数: `0`
- 输入 tokens 总和: `922548`
- 输出 tokens 总和: `19048`
- 总 tokens 总和: `1149660`
- cache read 总和: `208064`
- 平均每任务 totalTokens: `38322`
- 中位附近 totalTokens: `40862`

## 观察

- 最高消耗任务: `task_7e198a5b-8bce-4a6b-956c-5d8a9d78c068`，`78098` tokens，URL=`https://jiankang.usst.edu.cn/2021/0611/page.htm`
- 最低消耗任务: `task_0e32cc01-10f5-4be7-ba4a-312f0287740a`，`16173` tokens，URL=`https://drive.google.com/file/d/1p5tA6eTTbw4tnIShTrsLTyUD6mKx1zYb/view?usp=drive_link`
- 最近这批任务多数是专家主页抽取，token 主要集中在 `7.8k ~ 9.5k` 区间。

## Top 10 高消耗任务

| 排名 | taskId | createdAt | status | totalTokens | input | output | cacheRead | URL |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `task_7e198a5b-8bce-4a6b-956c-5d8a9d78c068` | `2026-04-20T03:13:42.314Z` | `SUCCEEDED` | 78098 | 59771 | 1111 | 17216 | https://jiankang.usst.edu.cn/2021/0611/page.htm |
| 2 | `task_7305e810-b088-43b4-804c-c1ebfb14b60b` | `2026-04-20T02:58:12.772Z` | `SUCCEEDED` | 51339 | 42713 | 882 | 7744 | https://dev.ais.cn:7779/expert/detail/12109 |
| 3 | `task_64db7b34-1216-48ce-904e-059bbd01ee9e` | `2026-04-20T06:31:55.998Z` | `SUCCEEDED` | 50757 | 49918 | 839 | 0 | https://t1.ais.cn:7779/expert/main |
| 4 | `task_1d9404ef-6887-439b-b66a-3190ac065775` | `2026-04-20T02:22:48.289Z` | `SUCCEEDED` | 50416 | 43267 | 877 | 6272 | https://t1.ais.cn:7779/expert/main |
| 5 | `task_c0c7641f-39eb-42eb-9b5d-f8119791901b` | `2026-04-20T03:10:40.553Z` | `SUCCEEDED` | 50395 | 49436 | 959 | 0 | https://t1.ais.cn:7779/expert/main |
| 6 | `task_232f9c21-2aa8-445d-9898-e4fa6dd637ce` | `2026-04-20T02:25:34.756Z` | `SUCCEEDED` | 50113 | 30635 | 790 | 18688 | https://t1.ais.cn:7779/expert/main |
| 7 | `task_d650a0e8-f281-4312-9c9d-868d9e63a8e0` | `2026-04-20T02:24:52.567Z` | `SUCCEEDED` | 49990 | 27247 | 727 | 22016 | https://t1.ais.cn:7779/expert/main |
| 8 | `task_f17b4eca-8101-45c8-a98a-46a563c76151` | `2026-04-20T02:11:26.764Z` | `SUCCEEDED` | 49852 | 19924 | 744 | 29184 | https://teacher.nwpu.edu.cn/liwenya.html |
| 9 | `task_285ac46e-abab-41e3-9b57-56324397d200` | `2026-04-20T03:43:56.203Z` | `SUCCEEDED` | 42233 | 41613 | 620 | 0 | http://baidu.com |
| 10 | `task_e9fe2718-a23e-4d57-97fb-0b998a4f7b58` | `2026-04-20T06:29:01.299Z` | `SUCCEEDED` | 41881 | 33205 | 676 | 8000 | https://t1.ais.cn:7779/expert/main |

## 最近 30 个任务明细

| # | taskId | status | totalTokens | input | output | cacheRead | latestRunId | URL |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `task_64db7b34-1216-48ce-904e-059bbd01ee9e` | `SUCCEEDED` | 50757 | 49918 | 839 | 0 | `run_3842c23b-5e46-47b1-995d-33b69f2fe7bc` | https://t1.ais.cn:7779/expert/main |
| 2 | `task_e9fe2718-a23e-4d57-97fb-0b998a4f7b58` | `SUCCEEDED` | 41881 | 33205 | 676 | 8000 | `run_9df18d0f-f425-4e09-bf82-53909e3fc06d` | https://t1.ais.cn:7779/expert/main |
| 3 | `task_b660f285-74d7-4082-9f06-752905939af9` | `SUCCEEDED` | 40931 | 40191 | 740 | 0 | `run_9eda090e-2126-41a4-8875-e5ed756a2919` | https://t1.ais.cn:7779/expert/main |
| 4 | `task_0e32cc01-10f5-4be7-ba4a-312f0287740a` | `SUCCEEDED` | 16173 | 15800 | 373 | 0 | `run_9897b5fb-d9bd-4166-ac19-0ca7f8b8da3a` | https://drive.google.com/file/d/1p5tA6eTTbw4tnIShTrsLTyUD6mKx1zYb/view?usp=drive_link |
| 5 | `task_285ac46e-abab-41e3-9b57-56324397d200` | `SUCCEEDED` | 42233 | 41613 | 620 | 0 | `run_beb0e7be-7559-42b4-89f3-6257de94b703` | http://baidu.com |
| 6 | `task_2deb3420-98fc-46a4-b24d-a50ee0743fc2` | `SUCCEEDED` | 40675 | 33863 | 604 | 6208 | `run_afcf219f-8905-4f34-a45f-c791c3d9d67a` | http://baidu.com |
| 7 | `task_b8a39869-af1b-448d-b8bf-231c0f6fdf30` | `SUCCEEDED` | 40862 | 32232 | 630 | 8000 | `run_c7d64b21-3f9c-46e3-9e23-bdd2780895a9` | https://tt.edu.cn |
| 8 | `task_670043b3-6ca6-49a2-8a0c-a443af31f637` | `SUCCEEDED` | 32151 | 19229 | 442 | 12480 | `run_47d15da9-2e32-4250-8c51-cc2adff116c7` | https://tt.edu.cn |
| 9 | `task_27340621-ddf5-4f42-a285-46fac839dd4c` | `SUCCEEDED` | 32253 | 31821 | 432 | 0 | `run_c43be37e-ca89-4a2b-b8ef-0b6eba07f0eb` | https://tt.edu.cn |
| 10 | `task_51c6a770-7774-4394-b291-3d19c04956c7` | `SUCCEEDED` | 23935 | 23558 | 377 | 0 | `run_6fecb42d-b398-4e52-95c5-42e9990475a0` | https://tt.edu.cn |
| 11 | `task_f5685323-48e3-4640-9929-9f6882ac2842` | `SUCCEEDED` | 23944 | 17291 | 381 | 6272 | `run_11e55dc6-9900-4688-9857-35f89e33b26e` | https://tt.edu.cn |
| 12 | `task_10d41770-4468-476e-9ffa-c3533411da09` | `SUCCEEDED` | 32383 | 31874 | 509 | 0 | `run_223d717a-0182-4663-897f-ff55592e03e6` | https://tt.edu.cn |
| 13 | `task_24677368-a5b6-440a-aa77-e7bbc7b0ab1d` | `SUCCEEDED` | 23933 | 23555 | 378 | 0 | `run_7f43abcc-3108-4628-a00a-729cbf9af7c0` | https://tt.edu.cn |
| 14 | `task_249edc65-fd16-4ac8-81f2-f11fb64aa0bb` | `SUCCEEDED` | 23914 | 23540 | 374 | 0 | `run_2dfaf1b7-fb69-46e6-9e8a-6a3aae8e51d7` | https://tt.edu.cn |
| 15 | `task_24e5142f-634e-46b1-a7a6-fc4ade725f87` | `SUCCEEDED` | 32227 | 11336 | 411 | 20480 | `run_eccc2304-67aa-495a-a2fc-28828ea6bc4f` | https://tt.edu.cn |
| 16 | `task_89ac4f28-c3ba-46e0-936b-e26fb7cbea2a` | `SUCCEEDED` | 33612 | 26588 | 752 | 6272 | `run_ca30470b-203c-4b42-846d-b7f5714b081a` | https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm |
| 17 | `task_277e6fc7-5eae-4ba1-9b37-c46aede317fc` | `SUCCEEDED` | 23934 | 17351 | 375 | 6208 | `run_0d86abba-cce1-4ccd-a350-79cab65c33fd` | https://tt.edu.cn |
| 18 | `task_80a30773-6d2b-4744-ba9c-a2b9cc6354ae` | `SUCCEEDED` | 40977 | 34086 | 683 | 6208 | `run_5d828743-42ca-474e-9a0b-7978abc1127c` | https://tt.edu.cn |
| 19 | `task_030d4822-f30d-4ce1-a142-67e804f072d0` | `SUCCEEDED` | 40852 | 33970 | 674 | 6208 | `run_843fabb8-966b-44ca-af71-6ec471277c09` | https://t1.ais.cn:7779/expert/main |
| 20 | `task_7e198a5b-8bce-4a6b-956c-5d8a9d78c068` | `SUCCEEDED` | 78098 | 59771 | 1111 | 17216 | `run_95d68d88-09af-4c60-8f19-fd325570b670` | https://jiankang.usst.edu.cn/2021/0611/page.htm |
| 21 | `task_c0c7641f-39eb-42eb-9b5d-f8119791901b` | `SUCCEEDED` | 50395 | 49436 | 959 | 0 | `run_f5b9cf06-aaa1-480d-bf48-b7a783ad55f7` | https://t1.ais.cn:7779/expert/main |
| 22 | `task_7305e810-b088-43b4-804c-c1ebfb14b60b` | `SUCCEEDED` | 51339 | 42713 | 882 | 7744 | `run_89e521e2-364a-4de5-85e9-c02fba9fa337` | https://dev.ais.cn:7779/expert/detail/12109 |
| 23 | `task_75c09b89-dad1-4d73-98f2-ffbdb497bc2a` | `SUCCEEDED` | 40916 | 40222 | 694 | 0 | `run_7ded8f59-e103-4080-bd0a-3673cdbcfe4a` | https://jiankang.usst.edu.cn/2021/0611/page.htm |
| 24 | `task_1e24f9a9-fa46-438c-85a2-a778c27a4b65` | `SUCCEEDED` | 33593 | 32858 | 735 | 0 | `run_67fc1df4-d040-4ad3-b6e9-de06d4d304bf` | https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm |
| 25 | `task_232f9c21-2aa8-445d-9898-e4fa6dd637ce` | `SUCCEEDED` | 50113 | 30635 | 790 | 18688 | `run_52f5a027-461d-4fff-967b-496b2461adde` | https://t1.ais.cn:7779/expert/main |
| 26 | `task_d650a0e8-f281-4312-9c9d-868d9e63a8e0` | `SUCCEEDED` | 49990 | 27247 | 727 | 22016 | `run_eeee75c6-6e2f-4958-ad5b-a2a8e453b1bb` | https://t1.ais.cn:7779/expert/main |
| 27 | `task_1d9404ef-6887-439b-b66a-3190ac065775` | `SUCCEEDED` | 50416 | 43267 | 877 | 6272 | `run_aeb0d428-dcd1-4cb4-b314-ab0d0a2a4bae` | https://t1.ais.cn:7779/expert/main |
| 28 | `task_941631be-4ffc-4284-b95e-683b58260d13` | `SUCCEEDED` | 40897 | 19554 | 735 | 20608 | `run_aa286c91-61cc-4e6e-a8d5-f28431219c98` | https://t1.ais.cn:7779/expert/main |
| 29 | `task_b2631a7e-7d2a-4883-af02-8446ed441da7` | `SUCCEEDED` | 16424 | 15900 | 524 | 0 | `run_97f2fcf9-5484-42df-81cc-9c85a79f52c0` | https://drive.google.com/file/d/1p5tA6eTTbw4tnIShTrsLTyUD6mKx1zYb/view?usp=drive_link |
| 30 | `task_f17b4eca-8101-45c8-a98a-46a563c76151` | `SUCCEEDED` | 49852 | 19924 | 744 | 29184 | `run_79bb5048-1759-4938-812d-55b33a663607` | https://teacher.nwpu.edu.cn/liwenya.html |