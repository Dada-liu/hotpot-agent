# SWE-bench Lite 300 跑批记录（2026-11-08）

全量 300 题的跑批汇总。逐题明细见文末附录；机器可读汇总为跑批机器上的 `~/hotpot-agent/lite300-report.json`。

## 跑批条件

| 项 | 值 |
|------|------|
| 数据集 / 切片 | `SWE-bench/SWE-bench_Lite`，split `test`，300 题 |
| 运行机器 | macmini（Apple Silicon + Docker Desktop amd64 模拟） |
| 时间窗口 | 2026-10-30 19:01 ~ 2026-11-08 03:35（25 波 × 12 题） |
| 代码版本 | `a6ad991`（2026-10-26，`feat: 加固本地 API 与权限模式`） |
| 模型档位 | high = `k3`，medium / low = `kimi-for-coding`，均走 `https://api.kimi.com/coding/v1` |
| 运行配置 | `HOTPOT_HOME=~/.lite300-home` 快照配置；`--eval-mode local --max-workers 4` |
| 评分口径 | patch-only 基线；pass/fail 全部来自官方 `swebench` harness 的 `resolved` 列表 |

与 2026-10-19 的 Lite 10 题验收（DeepSeek 档位）相比，模型档位、题目数量与运行批次都不同，
两组数字不能直接对比，也不构成回归或提升结论。

## 结果总览

| 指标 | 数值 |
|------|------|
| 通过 | **168/300（56.0%）** |
| 平均单题 input token | 393,786.8（合计约 1.18 亿） |
| 平均单题 output token | 9,887.6（合计约 297 万） |
| 平均单题耗时 | 323.4s（约 5.4 分钟） |

分仓库通过率：

| 仓库 | 通过 | 通过率 |
|------|------|--------|
| django | 75/114 | 65.8% |
| sympy | 40/77 | 51.9% |
| scikit-learn | 15/23 | 65.2% |
| matplotlib | 11/23 | 47.8% |
| pytest-dev | 8/17 | 47.1% |
| sphinx-doc | 10/16 | 62.5% |
| astropy | 4/6 | 66.7% |
| pylint-dev | 3/6 | 50.0% |
| psf | 0/6 | 0.0% |
| pydata | 0/5 | 0.0% |
| mwaskom | 2/4 | 50.0% |
| pallets | 0/3 | 0.0% |

## 失败原因

132 题失败，按各波 `report.json` 的 `error` 字段分类：

| 失败原因 | 题数 | 含义 |
|----------|------|------|
| `unresolved by official harness` | 59 | patch 已生成但官方测试未通过（定位或修复错误） |
| `turn aborted` | 43 | agent 回合被中断（超时或会话中断） |
| `max_tokens` | 26 | 回合以 `max_tokens` 结束，patch 未完成 |
| `empty patch` | 2 | 未产生任何修改 |
| `fetch failed` | 1 | 模型请求失败 |
| `terminated` | 1 | 进程被终止 |

`turn aborted` 与 `max_tokens` 合计 69 题，属 agent / 配置侧中断，不代表 patch 内容一定错误；
调大超时或输出上限后这部分有回收空间。统计以 `report.json` 为准，不以逐波 `report.md` 为准（见下文）。

## 逐波通过数

| 波次 | 通过 | 波次 | 通过 | 波次 | 通过 | 波次 | 通过 | 波次 | 通过 |
|------|------|------|------|------|------|------|------|------|------|
| 01 | 8/12 | 06 | 9/12 | 11 | 5/12 | 16 | 5/12 | 21 | 7/12 |
| 02 | 8/12 | 07 | 10/12 | 12 | 7/12 | 17 | 9/12 | 22 | 7/12 |
| 03 | 9/12 | 08 | 3/12 | 13 | 1/12 | 18 | 6/12 | 23 | 5/12 |
| 04 | 10/12 | 09 | 9/12 | 14 | 4/12 | 19 | 7/12 | 24 | 7/12 |
| 05 | 6/12 | 10 | 7/12 | 15 | 7/12 | 20 | 4/12 | 25 | 8/12 |

波间波动明显：最高 10/12（wave 04、07），最低 1/12（wave 13）；wave 08 与 wave 20 分别为 3/12、4/12。
低波次的失败以官方 `unresolved` 为主，不能全部归因于配额中断或超时；单次全量的 56.0% 应结合这一波动理解。

## 与 Lite 10 的对照

两次跑批重叠 10 题，结果一致 6 题：

| instanceId | Lite 10 | Lite 300 | 一致 |
|------------|---------|----------|------|
| django__django-13710 | pass | pass | 是 |
| django__django-14238 | pass | pass | 是 |
| django__django-15695 | pass | fail | 否 |
| django__django-16595 | pass | pass | 是 |
| pylint-dev__pylint-7228 | fail | pass | 否 |
| sphinx-doc__sphinx-7686 | pass | fail | 否 |
| sympy__sympy-13647 | pass | pass | 是 |
| sympy__sympy-17139 | pass | pass | 是 |
| sympy__sympy-17655 | pass | fail | 否 |
| sympy__sympy-18532 | pass | pass | 是 |

3 题 pass→fail、1 题 fail→pass。题目来自公开 benchmark，模型训练语料可能覆盖相关内容。

## 成本（订阅口径）

| 项 | 数值 |
|------|------|
| 合计 | 约 200 元 |
| 单题 | 约 0.67 元 |
| 单通过题 | 约 1.19 元 |
| 单题 token 单价 | 约 17 元 / 千万 input token（200 元 ÷ 约 1.18 亿） |

口径说明：按 Kimi 订阅用量折算（老套餐两周用量 + Plus 月度 80% + Pro 月度 14%，各按套餐月费乘用量占比），
**不是 API 列表价**，随套餐、限流与折扣变化。跑批期间三次打满配额（5 小时窗口与月度上限），
靠分波与断点续跑恢复。

## 复现与产物

```bash
# 导出全量 300 题实例
python benchmarks/scripts/export_instances.py \
  --dataset SWE-bench/SWE-bench_Lite --split test \
  --output instances-lite300.jsonl

# 单波示例（12 题，输出目录逐波复用）
pnpm bench swebench --instances-file instances-lite300.jsonl \
  --instance-ids <12 个 id> --eval-mode local --max-workers 4 \
  --output benchmark-runs/lite300-wave-01-swebench
```

完整分波脚本与配额续跑脚本在跑批机器的 `~/hotpot-agent/`（`run-lite300.sh`、`resume-lite300.sh`、
`merge-partial.py`、`summarize-lite300.py`），不随仓库提交。

产物（macmini，不提交仓库）：

- `~/hotpot-agent/benchmark-runs/lite300-wave-01..25-swebench/`：逐波 `report.json`、`predictions.jsonl`、`official/`
- `~/hotpot-agent/lite300-report.md` / `lite300-report.json`：本次汇总与逐题明细

**读报告注意**：续跑合并（`merge-partial.py`）只改写逐波的 `report.json` 与 `predictions.jsonl`，
逐波 `report.md` 与 `official/` 保留的是该波首次尝试的快照。汇总通过率、token 与失败原因一律读 `report.json`。

## 各题明细

| instanceId | pass/fail | inputTokens | outputTokens | durationMs |
|---|---|---|---|---|
| astropy__astropy-12907 | pass | 184732 | 8135 | 604361 |
| astropy__astropy-14182 | fail | 253078 | 7354 | 604513 |
| astropy__astropy-14365 | pass | 494088 | 8783 | 432242 |
| astropy__astropy-14995 | pass | 403775 | 8622 | 344942 |
| astropy__astropy-6938 | pass | 48378 | 3260 | 112201 |
| astropy__astropy-7746 | fail | 274910 | 15808 | 396991 |
| django__django-10914 | fail | 104792 | 13468 | 373195 |
| django__django-10924 | pass | 238497 | 8372 | 261406 |
| django__django-11001 | pass | 168433 | 8637 | 157897 |
| django__django-11019 | fail | 299707 | 11135 | 606072 |
| django__django-11039 | pass | 44082 | 2599 | 74767 |
| django__django-11049 | pass | 46212 | 2940 | 171814 |
| django__django-11099 | pass | 15020 | 873 | 51601 |
| django__django-11133 | pass | 46315 | 2052 | 100154 |
| django__django-11179 | pass | 22154 | 1243 | 60460 |
| django__django-11283 | fail | 29840 | 4958 | 134169 |
| django__django-11422 | pass | 38365 | 4967 | 131908 |
| django__django-11564 | fail | 1499 | 8192 | 117340 |
| django__django-11583 | pass | 59566 | 3934 | 141033 |
| django__django-11620 | pass | 126557 | 9573 | 337862 |
| django__django-11630 | pass | 113668 | 23946 | 611976 |
| django__django-11742 | fail | 111080 | 4972 | 283413 |
| django__django-11797 | fail | 457381 | 8614 | 607844 |
| django__django-11815 | pass | 45909 | 2984 | 156797 |
| django__django-11848 | pass | 340720 | 20983 | 407546 |
| django__django-11905 | pass | 39251 | 4304 | 167164 |
| django__django-11910 | pass | 605459 | 17171 | 616065 |
| django__django-11964 | pass | 23159 | 1880 | 86671 |
| django__django-11999 | pass | 180500 | 5778 | 203496 |
| django__django-12113 | fail | 72749 | 13923 | 370672 |
| django__django-12125 | fail | 29145 | 8423 | 161258 |
| django__django-12184 | pass | 46272 | 2372 | 184318 |
| django__django-12284 | fail | 41268 | 12592 | 655415 |
| django__django-12286 | pass | 44946 | 3628 | 98401 |
| django__django-12308 | pass | 55516 | 3337 | 154694 |
| django__django-12453 | pass | 30400 | 1364 | 96567 |
| django__django-12470 | fail | 170604 | 13903 | 639743 |
| django__django-12497 | pass | 42442 | 2373 | 83205 |
| django__django-12589 | fail | 269226 | 21403 | 624446 |
| django__django-12700 | pass | 40826 | 3421 | 127032 |
| django__django-12708 | pass | 97547 | 5993 | 208913 |
| django__django-12747 | pass | 29899 | 2066 | 92140 |
| django__django-12856 | pass | 242870 | 10353 | 672701 |
| django__django-12908 | pass | 47372 | 4364 | 151957 |
| django__django-12915 | pass | 36768 | 1901 | 96453 |
| django__django-12983 | pass | 36292 | 2233 | 106957 |
| django__django-13028 | pass | 74411 | 6040 | 202675 |
| django__django-13033 | pass | 1046857 | 20930 | 612778 |
| django__django-13158 | fail | 45287 | 3207 | 154658 |
| django__django-13220 | pass | 164835 | 9274 | 639079 |
| django__django-13230 | pass | 27719 | 1202 | 59165 |
| django__django-13265 | fail | 2147591 | 22715 | 573257 |
| django__django-13315 | pass | 151245 | 16399 | 465395 |
| django__django-13321 | fail | 24836 | 1593 | 70517 |
| django__django-13401 | fail | 69711 | 5389 | 152055 |
| django__django-13447 | pass | 313392 | 11874 | 432035 |
| django__django-13448 | fail | 14267 | 10107 | 223124 |
| django__django-13551 | pass | 41822 | 2246 | 67986 |
| django__django-13590 | fail | 107628 | 5409 | 198760 |
| django__django-13658 | pass | 31760 | 1283 | 114691 |
| django__django-13660 | fail | 63131 | 3603 | 116581 |
| django__django-13710 | pass | 24450875 | 6823 | 612184 |
| django__django-13757 | pass | 45746 | 2937 | 108250 |
| django__django-13768 | pass | 52223 | 3279 | 111584 |
| django__django-13925 | pass | 193541 | 8546 | 396068 |
| django__django-13933 | pass | 30294 | 1882 | 56535 |
| django__django-13964 | fail | 104797 | 25683 | 609581 |
| django__django-14016 | pass | 154403 | 9749 | 270896 |
| django__django-14017 | pass | 62087 | 6437 | 154701 |
| django__django-14155 | fail | 103754 | 5817 | 116302 |
| django__django-14238 | pass | 48298 | 3291 | 107684 |
| django__django-14382 | pass | 17546 | 983 | 32196 |
| django__django-14411 | pass | 39328 | 8680 | 162625 |
| django__django-14534 | pass | 27317 | 1388 | 67088 |
| django__django-14580 | pass | 79438 | 4047 | 93113 |
| django__django-14608 | pass | 729437 | 13472 | 305162 |
| django__django-14667 | fail | 19867 | 8607 | 156438 |
| django__django-14672 | pass | 31641 | 1115 | 79827 |
| django__django-14730 | fail | 77837 | 6239 | 130025 |
| django__django-14752 | pass | 25279 | 1621 | 34713 |
| django__django-14787 | pass | 22274 | 4533 | 64548 |
| django__django-14855 | pass | 34560 | 1702 | 87855 |
| django__django-14915 | pass | 60334 | 1232 | 89947 |
| django__django-14997 | pass | 323006 | 23227 | 512168 |
| django__django-14999 | fail | 53109 | 5082 | 112397 |
| django__django-15061 | fail | 74429 | 3986 | 98170 |
| django__django-15202 | fail | 37550 | 6225 | 129439 |
| django__django-15213 | fail | 103188 | 17910 | 369025 |
| django__django-15252 | fail | 18838 | 13232 | 356271 |
| django__django-15320 | fail | 37499 | 2433 | 78322 |
| django__django-15347 | pass | 13886 | 867 | 28517 |
| django__django-15388 | fail | 92782 | 16427 | 367859 |
| django__django-15400 | pass | 45603 | 2565 | 69707 |
| django__django-15498 | pass | 23920 | 3069 | 79526 |
| django__django-15695 | fail | 31234 | 6653 | 144492 |
| django__django-15738 | fail | 1410822 | 23757 | 610542 |
| django__django-15781 | pass | 181356 | 6837 | 238934 |
| django__django-15789 | pass | 27770 | 2470 | 82522 |
| django__django-15790 | pass | 39245 | 3395 | 86761 |
| django__django-15814 | pass | 180391 | 16275 | 441522 |
| django__django-15819 | fail | 41807 | 23610 | 461280 |
| django__django-15851 | pass | 44198 | 2004 | 56430 |
| django__django-15902 | pass | 501153 | 22941 | 585094 |
| django__django-15996 | fail | 82035 | 6171 | 164626 |
| django__django-16041 | pass | 71844 | 4819 | 140625 |
| django__django-16046 | pass | 22044 | 5354 | 165347 |
| django__django-16139 | pass | 20264 | 1380 | 54375 |
| django__django-16229 | fail | 74556 | 19324 | 610748 |
| django__django-16255 | pass | 84711 | 3785 | 120857 |
| django__django-16379 | pass | 22782 | 1279 | 48712 |
| django__django-16400 | fail | 120702 | 21247 | 605371 |
| django__django-16408 | fail | 524703 | 14984 | 606085 |
| django__django-16527 | pass | 20272 | 1022 | 71494 |
| django__django-16595 | pass | 40238 | 2498 | 82099 |
| django__django-16816 | fail | 182075 | 21751 | 606311 |
| django__django-16820 | pass | 198809 | 23655 | 605203 |
| django__django-16873 | pass | 100899 | 4889 | 142265 |
| django__django-16910 | fail | 352294 | 10119 | 611093 |
| django__django-17051 | fail | 0 | 0 | 26037 |
| django__django-17087 | pass | 103195 | 4550 | 150024 |
| matplotlib__matplotlib-18869 | fail | 241670 | 7320 | 255691 |
| matplotlib__matplotlib-22711 | fail | 354861 | 7364 | 680031 |
| matplotlib__matplotlib-22835 | fail | 16756 | 14831 | 396234 |
| matplotlib__matplotlib-23299 | fail | 778297 | 16534 | 646382 |
| matplotlib__matplotlib-23314 | pass | 1386001 | 10160 | 616949 |
| matplotlib__matplotlib-23476 | fail | 3281099 | 15154 | 630493 |
| matplotlib__matplotlib-23562 | pass | 571594 | 16024 | 624586 |
| matplotlib__matplotlib-23563 | fail | 416101 | 11553 | 613481 |
| matplotlib__matplotlib-23913 | pass | 63745 | 5420 | 212055 |
| matplotlib__matplotlib-23964 | pass | 613411 | 10680 | 619766 |
| matplotlib__matplotlib-23987 | fail | 2189719 | 1609 | 614565 |
| matplotlib__matplotlib-24149 | pass | 562181 | 10896 | 538308 |
| matplotlib__matplotlib-24265 | pass | 295595 | 16142 | 279859 |
| matplotlib__matplotlib-24334 | fail | 367990 | 11777 | 335020 |
| matplotlib__matplotlib-24970 | pass | 498445 | 15370 | 381508 |
| matplotlib__matplotlib-25079 | fail | 79666 | 9020 | 229336 |
| matplotlib__matplotlib-25311 | fail | 2527323 | 14348 | 605041 |
| matplotlib__matplotlib-25332 | pass | 3925880 | 40761 | 598210 |
| matplotlib__matplotlib-25433 | pass | 1017919 | 20759 | 559433 |
| matplotlib__matplotlib-25442 | pass | 24709 | 4645 | 162016 |
| matplotlib__matplotlib-25498 | fail | 569504 | 24130 | 507691 |
| matplotlib__matplotlib-26011 | pass | 610936 | 12292 | 486406 |
| matplotlib__matplotlib-26020 | fail | 153034 | 21763 | 324177 |
| mwaskom__seaborn-2848 | pass | 823744 | 26168 | 601567 |
| mwaskom__seaborn-3010 | pass | 31324 | 1977 | 47013 |
| mwaskom__seaborn-3190 | fail | 666958 | 18617 | 603856 |
| mwaskom__seaborn-3407 | fail | 284193 | 27315 | 604046 |
| pallets__flask-4045 | fail | 29972 | 1342 | 67568 |
| pallets__flask-4992 | fail | 112039 | 5422 | 124496 |
| pallets__flask-5063 | fail | 302421 | 7799 | 139626 |
| psf__requests-1963 | fail | 51615 | 1685 | 44599 |
| psf__requests-2148 | fail | 180691 | 17418 | 276653 |
| psf__requests-2317 | fail | 132403 | 5537 | 117051 |
| psf__requests-2674 | fail | 244340 | 15839 | 296062 |
| psf__requests-3362 | fail | 94071 | 6578 | 122351 |
| psf__requests-863 | fail | 48373 | 3247 | 70409 |
| pydata__xarray-3364 | fail | 11740 | 8524 | 157028 |
| pydata__xarray-4094 | fail | 257343 | 6723 | 604013 |
| pydata__xarray-4248 | fail | 267631 | 16650 | 596539 |
| pydata__xarray-4493 | fail | 968876 | 13576 | 604050 |
| pydata__xarray-5131 | fail | 48668 | 2430 | 58928 |
| pylint-dev__pylint-5859 | pass | 211145 | 9621 | 209525 |
| pylint-dev__pylint-6506 | fail | 144796 | 22031 | 604323 |
| pylint-dev__pylint-7080 | fail | 233256 | 6094 | 206978 |
| pylint-dev__pylint-7114 | fail | 11612 | 12341 | 304544 |
| pylint-dev__pylint-7228 | pass | 215326 | 17287 | 480765 |
| pylint-dev__pylint-7993 | pass | 103765 | 9995 | 290969 |
| pytest-dev__pytest-11143 | pass | 123630 | 5147 | 184228 |
| pytest-dev__pytest-11148 | fail | 11120 | 8367 | 230325 |
| pytest-dev__pytest-5103 | fail | 52190 | 11885 | 608977 |
| pytest-dev__pytest-5221 | fail | 1068494 | 19275 | 609428 |
| pytest-dev__pytest-5227 | pass | 497461 | 18457 | 608366 |
| pytest-dev__pytest-5413 | fail | 129445 | 12492 | 610363 |
| pytest-dev__pytest-5495 | pass | 153616 | 12444 | 478564 |
| pytest-dev__pytest-5692 | pass | 67733 | 2504 | 85322 |
| pytest-dev__pytest-6116 | pass | 24158 | 1698 | 64484 |
| pytest-dev__pytest-7168 | pass | 124405 | 6473 | 234062 |
| pytest-dev__pytest-7220 | fail | 95846 | 14464 | 392922 |
| pytest-dev__pytest-7373 | pass | 74330 | 3630 | 118083 |
| pytest-dev__pytest-7432 | pass | 153454 | 8187 | 234316 |
| pytest-dev__pytest-7490 | fail | 34876 | 10931 | 387292 |
| pytest-dev__pytest-8365 | fail | 5788 | 8290 | 228037 |
| pytest-dev__pytest-8906 | fail | 61818 | 6018 | 225642 |
| pytest-dev__pytest-9359 | fail | 6238 | 8666 | 238427 |
| scikit-learn__scikit-learn-10297 | pass | 318116 | 6935 | 481193 |
| scikit-learn__scikit-learn-10508 | fail | 38661 | 2744 | 191687 |
| scikit-learn__scikit-learn-10949 | fail | 160056 | 15269 | 604373 |
| scikit-learn__scikit-learn-11040 | fail | 75647 | 5060 | 271730 |
| scikit-learn__scikit-learn-11281 | pass | 364738 | 8393 | 442443 |
| scikit-learn__scikit-learn-12471 | pass | 239052 | 9498 | 407712 |
| scikit-learn__scikit-learn-13142 | pass | 282916 | 7162 | 604433 |
| scikit-learn__scikit-learn-13241 | pass | 37298 | 2300 | 128447 |
| scikit-learn__scikit-learn-13439 | fail | 66596 | 3460 | 622880 |
| scikit-learn__scikit-learn-13496 | pass | 121837 | 3629 | 210618 |
| scikit-learn__scikit-learn-13497 | pass | 90446 | 3690 | 202971 |
| scikit-learn__scikit-learn-13584 | pass | 180283 | 9850 | 298860 |
| scikit-learn__scikit-learn-13779 | pass | 51596 | 5219 | 475050 |
| scikit-learn__scikit-learn-14087 | fail | 113718 | 4557 | 618330 |
| scikit-learn__scikit-learn-14092 | pass | 66187 | 7617 | 243919 |
| scikit-learn__scikit-learn-14894 | pass | 62075 | 4517 | 303274 |
| scikit-learn__scikit-learn-14983 | pass | 195331 | 12779 | 519471 |
| scikit-learn__scikit-learn-15512 | pass | 482974 | 10219 | 625322 |
| scikit-learn__scikit-learn-15535 | pass | 137947 | 4540 | 263726 |
| scikit-learn__scikit-learn-25500 | fail | 643891 | 13170 | 657969 |
| scikit-learn__scikit-learn-25570 | pass | 210156 | 18552 | 440195 |
| scikit-learn__scikit-learn-25638 | fail | 9784 | 8398 | 183096 |
| scikit-learn__scikit-learn-25747 | fail | 8251 | 8329 | 126145 |
| sphinx-doc__sphinx-10325 | pass | 530653 | 21552 | 607274 |
| sphinx-doc__sphinx-10451 | fail | 146062 | 12568 | 250198 |
| sphinx-doc__sphinx-11445 | pass | 81411 | 15047 | 376133 |
| sphinx-doc__sphinx-7686 | fail | 134406 | 13026 | 278477 |
| sphinx-doc__sphinx-7738 | pass | 130804 | 11797 | 605397 |
| sphinx-doc__sphinx-7975 | pass | 31964 | 5066 | 116716 |
| sphinx-doc__sphinx-8273 | fail | 88768 | 4143 | 115790 |
| sphinx-doc__sphinx-8282 | fail | 918050 | 10269 | 250194 |
| sphinx-doc__sphinx-8435 | pass | 5562862 | 11623 | 397297 |
| sphinx-doc__sphinx-8474 | pass | 287570 | 11658 | 583062 |
| sphinx-doc__sphinx-8506 | fail | 39341 | 6954 | 608311 |
| sphinx-doc__sphinx-8595 | pass | 150009 | 4927 | 269375 |
| sphinx-doc__sphinx-8627 | fail | 140518 | 10012 | 208209 |
| sphinx-doc__sphinx-8713 | pass | 107647 | 2376 | 95663 |
| sphinx-doc__sphinx-8721 | pass | 97135 | 5608 | 175508 |
| sphinx-doc__sphinx-8801 | pass | 1426292 | 20081 | 605917 |
| sympy__sympy-11400 | pass | 201984 | 12618 | 411237 |
| sympy__sympy-11870 | fail | 592322 | 12844 | 604943 |
| sympy__sympy-11897 | fail | 248292 | 18194 | 604679 |
| sympy__sympy-12171 | fail | 22297 | 1299 | 41221 |
| sympy__sympy-12236 | pass | 3472605 | 21701 | 600477 |
| sympy__sympy-12419 | pass | 1912757 | 21864 | 555274 |
| sympy__sympy-12454 | fail | 86017 | 4357 | 132456 |
| sympy__sympy-12481 | fail | 763893 | 18903 | 488145 |
| sympy__sympy-13031 | fail | 1593138 | 19667 | 604416 |
| sympy__sympy-13043 | fail | 74988 | 5164 | 111628 |
| sympy__sympy-13146 | fail | 617308 | 16367 | 475515 |
| sympy__sympy-13177 | fail | 92729 | 8199 | 180786 |
| sympy__sympy-13437 | fail | 100046 | 3323 | 94718 |
| sympy__sympy-13471 | pass | 129357 | 11319 | 215020 |
| sympy__sympy-13480 | pass | 96532 | 3793 | 111064 |
| sympy__sympy-13647 | pass | 423455 | 13031 | 343041 |
| sympy__sympy-13773 | fail | 2181468 | 8797 | 606809 |
| sympy__sympy-13895 | fail | 1735118 | 26583 | 626013 |
| sympy__sympy-13915 | pass | 656353 | 17790 | 607009 |
| sympy__sympy-13971 | pass | 331385 | 8581 | 384646 |
| sympy__sympy-14024 | fail | 26518 | 5864 | 527015 |
| sympy__sympy-14308 | fail | 1615916 | 8316 | 606894 |
| sympy__sympy-14317 | fail | 153470 | 11254 | 376065 |
| sympy__sympy-14396 | pass | 244269 | 8574 | 398114 |
| sympy__sympy-14774 | pass | 70751 | 1853 | 101253 |
| sympy__sympy-14817 | pass | 467095 | 14241 | 612279 |
| sympy__sympy-15011 | pass | 331135 | 14515 | 440577 |
| sympy__sympy-15308 | fail | 98387 | 4440 | 164399 |
| sympy__sympy-15345 | pass | 64501 | 4010 | 175392 |
| sympy__sympy-15346 | fail | 317161 | 27208 | 558918 |
| sympy__sympy-15609 | pass | 188718 | 22246 | 707924 |
| sympy__sympy-15678 | pass | 77301 | 11704 | 271296 |
| sympy__sympy-16106 | pass | 175530 | 6258 | 260878 |
| sympy__sympy-16281 | fail | 23694 | 9756 | 255785 |
| sympy__sympy-16503 | fail | 165472 | 24572 | 656758 |
| sympy__sympy-16792 | pass | 312771 | 12700 | 457140 |
| sympy__sympy-16988 | pass | 144893 | 16353 | 429391 |
| sympy__sympy-17022 | pass | 433570 | 19720 | 600467 |
| sympy__sympy-17139 | pass | 116559 | 6979 | 180583 |
| sympy__sympy-17630 | fail | 377213 | 20145 | 604170 |
| sympy__sympy-17655 | fail | 509654 | 23302 | 669808 |
| sympy__sympy-18057 | fail | 374697 | 16660 | 451928 |
| sympy__sympy-18087 | fail | 811872 | 18938 | 600815 |
| sympy__sympy-18189 | pass | 148068 | 6069 | 189878 |
| sympy__sympy-18199 | fail | 114651 | 6693 | 200212 |
| sympy__sympy-18532 | pass | 521234 | 15514 | 301274 |
| sympy__sympy-18621 | pass | 125808 | 9522 | 249364 |
| sympy__sympy-18698 | fail | 2643120 | 11327 | 641564 |
| sympy__sympy-18835 | fail | 67045 | 11744 | 278939 |
| sympy__sympy-19007 | fail | 166050 | 16098 | 628528 |
| sympy__sympy-19254 | pass | 137354 | 19006 | 419756 |
| sympy__sympy-19487 | fail | 77396 | 2792 | 120997 |
| sympy__sympy-20049 | pass | 388036 | 14929 | 520061 |
| sympy__sympy-20154 | pass | 384702 | 19734 | 396025 |
| sympy__sympy-20212 | pass | 608572 | 17844 | 525543 |
| sympy__sympy-20322 | fail | 1193464 | 18179 | 608884 |
| sympy__sympy-20442 | pass | 64797 | 13868 | 265342 |
| sympy__sympy-20590 | pass | 43774 | 2673 | 72238 |
| sympy__sympy-20639 | fail | 42295 | 3822 | 114141 |
| sympy__sympy-21055 | pass | 130617 | 4756 | 149816 |
| sympy__sympy-21171 | fail | 83335 | 4387 | 109250 |
| sympy__sympy-21379 | pass | 74501 | 7705 | 185200 |
| sympy__sympy-21612 | fail | 123812 | 16748 | 610574 |
| sympy__sympy-21614 | pass | 248280 | 6619 | 177002 |
| sympy__sympy-21627 | fail | 908910 | 16605 | 396598 |
| sympy__sympy-21847 | pass | 94929 | 4147 | 103797 |
| sympy__sympy-22005 | pass | 154190 | 18355 | 321016 |
| sympy__sympy-22714 | pass | 65937 | 14096 | 369368 |
| sympy__sympy-22840 | fail | 769295 | 23184 | 548175 |
| sympy__sympy-23117 | pass | 125540 | 11109 | 223745 |
| sympy__sympy-23191 | fail | 603314 | 21578 | 610066 |
| sympy__sympy-23262 | pass | 402653 | 9192 | 360624 |
| sympy__sympy-24066 | pass | 162205 | 11506 | 264591 |
| sympy__sympy-24102 | fail | 145374 | 6654 | 200404 |
| sympy__sympy-24152 | pass | 43369 | 2911 | 60825 |
| sympy__sympy-24213 | pass | 38891 | 2293 | 53043 |
| sympy__sympy-24909 | fail | 73103 | 8005 | 156171 |
