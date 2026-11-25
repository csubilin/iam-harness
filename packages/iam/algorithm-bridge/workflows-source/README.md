# Workflows — 流程样板与包格式

**状态：没有出厂能力。** `Examples/ByProductOre/` 是流程格式的样板与回归夹具，
不参与 `iam_workflow_list`；真实能力由用户在工作区固化得到。

## 这里放什么

流程格式的样板，以及将来确实需要随产品发布的流程包。当前只有一个样板：
`Examples/ByProductOre/`。它放在 `Examples/` 下一层，`workflow_catalog` 只扫
`Workflows/*/manifest.json`，所以它不会出现在能力列表里——**出厂状态是零能力**，
第一个能力来自用户。

一个流程要进来，得先有值得写下来的三样东西：**输入要求**、**步骤依赖**、**验收规则**。
三样说不清楚就说明它还是一个一次性程序，不该占一个包。这三样在
`<流程>/manifest.json` 的 `inputs` / `steps` / `acceptance` 里，不在散文里。

## 它不是一个 npm 包

`Examples/ByProductOre/` 里没有 `package.json`、没有 `cordis.patch.yml`、没有 `lib/`，
**也不会有**：一个流程是「一个 Python 程序 + 一份清单」，由
`dsh-iam-algorithm-bridge` 的 `iam_workflow_run` 按名字调用。没有任何东西需要装进
profile，所以没有东西需要一个 row 去命名。

这带来一个直接的好处：**写一个流程不需要构建、不需要装包、不需要重启 harness**。
放一个目录、`iam_workflow_list` 下次就能看见它。

## 现有样板

| 目录 | 性质 | 回答 |
|---|---|---|
| `Examples/ByProductOre/` | example（回归夹具，不出现在 `iam_workflow_list`） | 输出所有巷道掘进副产矿石量及金属量 |

它曾经是出厂流程；现在只作为「manifest / inputs / steps / acceptance 怎么写」的
完整实物，以及 `bridge-tools.test.mjs` 的端到端夹具。删除它只损失样板与回归，
不损失产品能力。

## 用户流程放这里之外

**用户产生的流程不写进这个目录**——不往 checkout 里写。它们在工作区：

```
<工作区>/.iax/workflows/<名字>/{workflow.py, manifest.json}
```

冻结还会在 `<工作区>/.agents/skills/<名字>/SKILL.md` 生成这个能力的调用说明
（输入、步骤、结果路径）；`CapabilityForge` scaffold 时写的 `<领域>/SKILL.md`
是“何时固化”的工坊技能，两者不是同一份。

目录格式完全一样，`iam_workflow_list` 只列这一类（以及 `--directory` 指向的测试夹具）。
几条规矩：

- **同名拒绝，不覆盖**：两个根，或同一个根下的两个目录，如果 manifest 的 `name`
  相同，两个都不跑，报出两条路径让你改名。悄悄跑其中一个就是悄悄藏掉另一个。
- **来源决定怎么跑**：工作区来的进孙进程；`--directory` 指向的夹具（测试用）在进程内。
  见 `AlgorithmBridge/README.md` 的「用户流程：发现、隔离、固化」。
- **点目录不是能力**：目录名以点开头的不参与发现。工坊冻结期间把草稿停在
  `.draft-<name>-<时间戳>`，这个中间状态不会被列成可运行的能力。
- **固化是两步**：`iam_program_run` 留痕到 `.iax/runs/`，`iam_workflow_freeze`
  把一次留痕 + 一份 manifest 写成 `.iax/workflows/<名>/`。缺 `inputs`/`steps`/`acceptance`
  就拒绝——门槛在这儿，不在文档里。
- **草稿与生效**：manifest 可以带 `status: "draft" | "active"`。`CapabilityForge`
  的 scaffold 生成 draft；`iam_workflow_list` 每项都返回 `status`，draft 排在 active
  之后；`iam_workflow_run` 拒绝 draft，并提示填好、先跑、再 freeze。直接
  `iam_workflow_freeze` 保留 manifest 里的状态；`capability_freeze` 以 draft 冻结，
  锁写好后最后写 active。**没有 `status` 字段按 active 处理**，所以旧流程和
  `Examples/ByProductOre/` 原样工作。
- manifest 除 `title`/`answers`/`inputs`/`steps`/`acceptance` 外，还接受：`version`（semver，
  同名演进靠它）、`status`（`draft`/`active`；缺省 active）、`supersedes`、`requires_catalog`（所需算法目录版本）、`derived`（由数据推出的量）、
  `consumes`/`produces`（上游/下游契约与产物）、`specs`（随流程发布、工作区可覆盖的规范）、
  `acceptance_checks`（与 `acceptance` 等长、id 顺序一致的可执行断言）、`acceptance_params`、
  `known_limits`、`deliverable`（`primary` 必填），以及只给人读的 `comment`。
- **不认识的字段会被拒绝**（`bridge.py` 的 `EXTENSION_FIELDS`）。拼错 `acceptance_checks`
  是一个错误，而不是一个被忽略的字段——后者会让报告里的"验收通过"变成一句没人测过的话。

## 这一层与「理解」的分工

流程**不理解自然语言**。它接收的是已经解析好的输入（一个项目、一个块段模型 id、
一个品位列 id、一个体重值），以及一张**术语表**——把「巷道」「矿体」对到项目事实上的一层
数据，放在工作区的 `.iax/glossary.json`，用户可读可改可增补。

模型怎么把一句中文对到这些输入上，是使用阶段的事；流程负责的是「一旦对上了，
结果是什么意思、什么情况下拒绝出数」。这条分工是刻意的：**能用数据表达的，
就不写进代码**。
