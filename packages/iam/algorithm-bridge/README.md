# AlgorithmBridge — 算法库的检索面与执行入口

一个 host-only `tool` 插件。它把 `IAM/Algorithms` 的算法目录交给模型，并把
「生成的 Python」跑起来。

平行轮廓建模现有原生流程入口 `geometry.surface.build_contour_model`：整理轮廓 → 普通/变分重建 → 保轮廓联合减面 → 单个 IAM 保存及全量几何回读验证。通过 search → describe → program_run 调用，默认使用版本化的 balanced 参数，也可显式调整。全矿体运行设置 `timeoutSeconds=3600`；打印简明 diagnostics，完整过程写入侧车报告。已有网格可分别调用 `geometry.surface.simplify_contour_models` 和 `geometry.surface.save_contour_model`。详细参数、输入映射和例子见[原生流程说明](../../Algorithms/docs/contour_model_native_pipeline_20261106.zh-CN.md)。

| 工具 | 读什么 | 做什么 |
|---|---|---|
| `iam_algorithm_search` | 编译进库的算法目录 | 按 operation 族返回**短条目**，不返回散条目 |
| `iam_algorithm_describe` | 同上 | 取选中那一条的完整契约：输入、前置条件、限制、结果 schema |
| `iam_algorithm_run` | 工作区算法 | 按 id 在受限执行器中运行用户算法 |
| `iam_mine_describe` | 一个 `.iam` / `.iamh` | 列出坐标系、语义元素与名字、几何引用、面的三角形数、块段模型与它的列 |
| `iam_workflow_list` | 仓库 + `<工作区>/.iax/workflows/` | 已固化的流程、状态、来源和输入要求 |
| `iam_workflow_run` | 同上 | 按名字跑一个流程，返回它的报告 |
| `iam_workflow_freeze` | 一次留痕的运行 | 把跑通过的程序 + 契约写成一个命名流程 |
| `iam_program_run` | — | 把一段 Python 送进子进程执行，带回 stdout / stderr / 退出码；有工作区时留痕到 `.iax/runs/` |

检索按**词**匹配：查询按空白切分，每个词都必须出现在条目中，命中位置决定排序——id、标题、
摘要里的命中排在仅在前置条件里被提及之前；整条 id 精确命中排第一，`geometry.boolean` 这样的
前缀当作族请求。所以 `interpolate contours` 能找到 `geometry.section.interpolate_contours`；
旧规则要求整串连续出现，同样的查询返回 0 条。一个词都匹配不到就是目录在回答「没有」，
不做近似匹配。

每个条目都带一行中文 `route`（名称与同义词），检索结果里与 `brief` 并列返回；中文问题靠它
命中英文条目（`体积`、`布尔`、`块段模型`、`品位`、`巷道`、`变差函数` 都有回归用例）。
`gen_catalog.py` 拒绝没有 `route` 的声明，所以新增算法必须同时写这一行。

空查询且不给 `operation` 时返回 **operation 族索引**：一行一个族，带条目数和后端。
全量清单约 100 KB，索引约 14 KB，所以「平台能做什么」从索引开始；`operation` 精确列出
一个族，`operation: "*"` 才返回全量。带 query 时族按相关度排序，空查询按字母序。

短条目还带 `select`：`exact` 与 `fails_silently` 各一个词。`unknown` 是**已声明的事实**——
还没人测过或定过，不是"安全值"；目前 27 条有取值（实体/平面布尔、体积、断面/放样、
隐式差集与等值面、自交扫描、三角化、网格处理变换），其余 151 条保持 `unknown`。
`fails_silently: true` 目前只有 `geometry.mesh.implicit_difference` 和
`geometry.surface.loft_contours`：前者会丢掉低于采样分辨率的特征，后者不认证自交。
两个词的含义和取值依据写在 `IAM/Algorithms/README.md`。

## 为什么是这两个族，而不是一条算法一个工具

目录有几十条，还会长到几百条。一条算法一个工具意味着**每一轮 prompt 组装**里都有几十个
schema，而模型是在一个看不全的清单里按名字挑。检索（search → describe）加一个执行入口，
把 prompt 成本压成常数，同时每一条都够得着。

`iam_algorithm_invoke` 曾经出现在这个包的预留说明里，**没有实现**：一个数在算法层里
是从一段程序内部取出来的，而那段程序的入口就是 `iam_program_run`。一个「只取一个数」的
旁路会变成第二套参数校验、第二套错误转换，去省一次进程启动。

用户算法放在 `<工作区>/.iax/algorithms/<目录>/`，包含 `algorithm.py` 和 `manifest.json`。
清单至少声明 `id`、`operation`、`title`、`inputs`、`result_schema`；程序提供
`WorkflowError` 异常类和 `run(**kwargs)`。检索同时返回内置与工作区算法，并标出来源；
工作区算法通过 `iam_algorithm_run` 执行，不能覆盖内置 id。

内置算法的首选 Python 调用方式由 `call_kind` 指定：`call_kind: direct` 时导入
`python_direct` 指定的函数，例如 `iam_algorithms.geometry.point_distance` 或
`iam_algorithms.direct.geometry__mesh__inspect`；`call_kind: invoke` 时调用
`Library.invoke(id, **arguments)`，该入口可按配置选择用户 Provider，再尝试内置实现和
其他 Provider。直接函数跳过 Provider 配置，不能被 Provider 覆盖。Harness 只根据目录
生成代码，不需要检查当前安装了哪些 Provider。

个别 invoke 条目在完整描述中仍保留 `python_direct` 兼容别名，但不能据此覆盖
`call_kind` 指定的首选路径；检索结果只展示 direct 条目的 `python_direct`，防止
同时出现两个入口而诱发误调用。

生成参数前，还必须读 `iam_algorithm_describe` 的 `entry.doc`，其中给出实际数组层级、
单位、返回值访问方法、结果再次输入的单位和拒绝条件。不要从 `python_name` 或
`c_symbol` 猜导入函数，也不要把相邻算法的参数套过来。几何输入需要特别核对：

- 平面环布尔用 `geometry.polygon.boolean`；`geometry.boolean.*` 接收 3D 实体句柄。
- 环是 `[[x,y,z], ...]`，一个布尔操作数是 `[外环, 洞环, ...]` 或 `[]`。独立外环
  不能混成同一操作数；LineSet 要先按段连接重建闭环，不能直接按顶点存储顺序取环。
- `coordinate_frame/length_unit` 标签不变换数据；输出 `PolygonRegionSet` 已是米，
  再次调用用 `length_unit="m", unit_to_meters=1`，保留洞并遍历全部区域。
- `clean(keep_nested=true)` 的重叠外环仍做并集，且不能在一次调用中恢复洞里的岛，
  岛要作为独立区域保留；它不等于全局偶奇/XOR。XY 面积、点分类和索引
  三角化不能直接接收垂直断面，也没有通用 `plane_normal` 或容差参数。
- 多材料断面直接使用 `iam_algorithms.section.tidy_contours`，保留显式孔洞与来源，
  不要先将全部材料压平交给 clean。clean 只处理无材料填充集合；tidy 内部复用它
  修复自交外环。tidy 的 `contact_tolerance` 不能照抄为 clean 的 `merge_tolerance`。
- tidy 的 `certified=True` 允许异材料包含及完全重合，不自动从外层材料扣洞；
  认证不等于互斥材料分区，嵌套材料面积不能直接相加。详见
  [职责边界与示例](../../Algorithms/SECTION_TIDY_CONTOURS.zh-CN.md#clean-与-tidy-的职责边界)。
- 几何拒绝要报告缺陷及当前参数，不能自动换单位、放大容差、丢洞、把失败当空集，
  或把实验中的材料优先级、断面分组、采样阈值当作算法默认规则。

### 断面建模与建模内核：先看 call_kind，再核对单位

这一组实验里最容易错的不是几何，而是**入口和单位**。目录条目已经带 `entry.doc`，
其中有完整输入结构、默认值、拒绝条件和可执行示例；下表只列最容易混的结论。

| 目录 ID | Python 入口 | 输入 | 输出单位 |
|---|---|---|---|
| `geometry.section.tidy_contours` | `section.tidy_contours(...)`（direct） | 带材料、显式孔洞和各自平面的断面 | **输入长度单位**；`*_m2` 为 m² |
| `geometry.section.interpolate_contours` | `modeling.interpolate_contours(...)`（direct；`Library.invoke` 抛 TypeError） | 2–64 张有序剖面，3D 世界坐标 | **输入长度单位**；面积为输入单位平方 |
| `geometry.surface.reconstruct_contours` | `library.invoke(...)`，返回 owned `LabelSurfaces` | `rings` + 每环一个 `section_index` 和一个 int32 `material`；**一次调用传入全部材料** | 默认 `"shared"` 导出规范共享界面，不记录体积变化，无体积目标与补偿，失败原子拒绝；显式 `"independent"` 保留旧逐材质语义；`field_smooth_sigma` 为 0..4、默认 0，正值仅 shared；读取 `diagnostics`、`smoothing_topology_changes` 和法向质量警示；Mesh 为输入单位，体积为 m³ |
| `geometry.surface.reconstruct_contours_variational` | `library.invoke(...)`，返回 owned `LabelSurfaces` | 与原重建入口相同的全部材料轮廓、标签和坐标元数据 | 独立三维变分算法：轴向加密、固定观测样本、梯度与完整 Hessian 求解，再共用共享界面提取和认证；读取收敛/拓扑/法向诊断；原入口与 pipeline 选择不变；无体积记录 |
| `geometry.contour.match_rings` | `modeling.match_rings(...)`（direct） | 2D 环 `[[x,y],...]` | `cost` 为输入单位平方 |
| `geometry.curve.periodic_heat` | `modeling.periodic_heat(...)`（direct） | 2D 环 + `time` | 坐标输入单位；`time` 为输入单位平方 |
| `geometry.mesh.build_distance_index` / `query_distances` | `modeling.*`（direct） | 3D 网格 / 走索引的查询点 | 距离为索引长度单位 |
| `geometry.polygon.boolean` / `clean` | `Library.invoke(...)` | 3D 共面环 | **米**；面积为 m² |

整断面插值（语义版本 9）允许同一材料有多个区域，区域间可以相离、点相切或共边：
共边是分支/复合处的缝合边，输入和输出都保留为两条闭合轮廓，`interfaces` 中
`left == right` 指向同一条共享边。包含、重合和正面积相交拒收，不自动取并集。
不要改成 `A#0/A#1` 绕过检查；`plane_tolerance` 和 `resolution` 不是最小间距。
该限制专属于 `modeling.interpolate_contours`，不限制通用布尔算法。归属拒绝的
`IamError.diagnostics` 带原始材料标签、断面内输入区域下标、交集面积和断面偏移；
应检索 `geometry.section.interpolate_contours` 并使用其 direct Python 入口。

`interpolate_contours` 与 `polygon.boolean` 的输出单位不同是刻意的：前者沿用输入
坐标系，后者转成米。把前者的结果当米再乘一次比例，会把 4 m 的剖面写成 400 m。

| 常见误调用 | 正确做法 |
|---|---|
| 对 `interpolate_contours` 用 `Library.invoke` | 它是 direct 条目：`from iam_algorithms import modeling`，再调同名函数。两个重建入口 `reconstruct_contours` 和 `reconstruct_contours_variational` 均走 invoke。 |
| 把 `interpolate_contours` 输出当米、或再乘 `unit_to_meters` | 输出坐标就是输入单位；`areas` 是输入单位平方。只有 `polygon.boolean/clean` 输出米。要把区域重建为实体，直接把同一单位的环交给 `reconstruct_contours`；单材料就是同一个 label。 |
| `plane_tolerance=0`，或拒绝后自动放大 | 必须有限且 **> 0**，默认 0.01 输入单位。`NONPLANAR_CONTOUR`、`SECTION_ORDER_OR_CROSSING` 要报出来，不能靠调大容差“跑通”。 |
| 同时传 `insert_count` 和 `fractions` | 二者互斥。`fractions` 是 1–32 个严格递增的 `(0,1)` 值，作用于每个区间。总插入数 ≤128，所以默认 3 时最多 43 张观测剖面。 |
| 剖面按任意顺序传入 | 必须沿第一剖面法向有序，且相邻分离大于 `plane_tolerance`；法向偏差 ≤ `maximum_angle_degrees`（默认 10，最大 30）。`id` 只是返回标签，不参与匹配。 |
| 把独立外环塞进同一轮廓的 `holes` | 独立区域是独立 contour；`holes` 只放严格内含、互不相交、不接触的孔。LineSet 先按线段连接重建闭环。 |
| `background_material` 等于某个输入材料 | 必须不同。整数 `7` 和字符串 `"7"` 是两种材料；输出保留原标签和类型。 |
| 给 `reconstruct_contours` 传部分重叠/不等长共边的不同材料 | 不同材料可以精确共边（含部分共线接边）或共点；正面积重叠、横穿仍拒收。同材料的共边和点接触是合法分支，按偶奇并集填充。嵌套 B 时 A 必须把 B 的边界作为自己的孔环，或依赖 inner override。材料标签只收 int32，字符串材料先映射成整数。 |
| 给 `reconstruct_contours` 传 `distance_method`/`interpolation`/`joint_materials`/`insert_count`/`narrow_band`/`termination_fraction` | 这些旧参数仍是 `TypeError`。一次传入全部材料，默认 `interface_mode="shared"` 构造统一界面，耦合失败整次拒绝；显式 `"independent"` 才顺序提取并在 `solids.failures` 报告逐材质失败。 |
| 把 `section_index` 当数组下标或要求 0,1,2 连续 | 它是 int32 标签；**升序即叠放顺序**，可跳号。站距必须沿轴向严格递增，反向会拒绝。 |
| 推断轴和 id 顺序相反 | 推断轴的方向由最大环的绕向决定。显式传 `section_axis`（z 向叠放用 `[0,0,1]`），或让 id 顺序与轴一致。 |
| 用 `reconstruct_contours` 的 `resolution` 加密轴向 | 它只控制横向 U/V 节点；轴向节点就是剖面位置。减小它只增加节点数，过多会触发预算拒绝（status 3）：默认共享模式与显式独立模式均最多 1 亿节点，且共享模式另受分数、活跃四面体和面片预算约束。 |
| 给 `reconstruct_contours_variational` 传旧平滑或模式开关 | 新入口始终共享；不接受 `interface_mode`、`field_smooth_sigma` 或 `require_section_continuity`。用 `axial_resolution` 加密轴向，`smooth_length`、`bending_weight` 和 `prior_weight` 控制变分目标；查看收敛与拓扑诊断，不能把平滑当作连通性保证。 |
| 把嵌套环当布尔并集 | `reconstruct_contours` 用偶奇：同材料的嵌套环是空腔，绕向不声明孔。`interpolate_contours` 的 `holes` 才是“该区域排除的孔”。 |
| 给 `reconstruct_contours` 传 `holes`、`closed`、`merge_tolerance`、`snap_tolerance` | 都不是它的参数。孔由嵌套或 inner override 表达；共面容差用 `plane_tolerance`，默认 `1e-7 × 面内跨度 + 64 ULP`。 |
| 给 `match_rings`/`periodic_heat` 传 3D 点 | 只收 2D `[[x,y],...]`。`periodic_heat` 的 `time` 是输入长度单位平方，不是秒；cm 输入的 m² 值要乘 10000。 |
| 比较两种 `objective` 的 `cost`，或把 `feasible=false` 当异常 | `length_integrated` 与 `bounded_fan` 的代价不可比；不可行是正常候选结果，数值溢出才是 `IamError`。 |
| 每次查询都重建距离索引，或跨 `iam_program_run` 传索引 | 索引是进程内快照：同一程序内建一次、查多次；源 Mesh 可以随后释放。 |
| 把布尔/clean 的 `merge_tolerance`、`snap_tolerance` 套到断面算法 | 参数名不同：插值和重建都用 `plane_tolerance`，重建另有 `contact_tolerance`。照抄会把单位或语义弄错。 |

拒绝时读取 `IamError.status`（1 输入错误、2 拒绝、3 资源上限）和消息里的
`interval=i->j`、`fraction=t`、`section=`、`region=`。插值条目没有 `.code` 属性
（只有 `polygon.boolean` 会附 `code`）；不要把 `feasible=false`、空 region set 或
拒绝都当成同一件事。

这些约定随当前编译目录返回，不依赖 harness 能否读取源码仓库。运行时没有相应条目时，
应报告当前构建不提供该算法；不要仅凭这份文档绕过目录调用旧库。

新算法的预算与约束见[使用说明](../../Algorithms/VARIATIONAL_CONTOUR_RECONSTRUCTION.zh-CN.md)。

`result_schema` 是**执行**的，但只执行两条规则：`type`，以及对象上的 `required`。
其余关键字（`properties`、`items`、`enum`、`$ref`、`format`）会被搬运、经
`iam_algorithm_describe` 公布给调用方，**但不校验**。这条边界是刻意的：本插件没有 JSON
Schema 校验器依赖，也不该自带半份标准实现——一份看起来完整的部分校验，比一份说清楚自己
停在哪的小校验更危险。两条规则抓的是真正会犯的错：声明对象却返回数组，或者改字段名之后
没改清单。`type: number` 不接受 `true`（Python 里 `bool` 是 `int` 的子类）。

## 为什么是 Python 而不是 TypeScript

`host/` 定位解释器、传递额外的 `PYTHONPATH`、spawn 并读回一个 JSON 对象。
普通构建只复制内置工作流；打包时临时放入 Python 绑定。所有的实质工作都在 `python/bridge.py`，因为每一次调用都要**一个 Python 库**——
算法的 nanobind 绑定、Mining port、流程模块——它们在 Node 侧没有等价物。搬到这边来
就是把绑定重写一遍；留在这边，这一半就只是一个进程启动器。

### 两个 Python 目录的关系

- `IAM/Host/Python/Source/` 是 nanobind 绑定源码；CMake 从 catalog 和加载模板生成 `<build>/IAM/Host/Python/iam_algorithms/`，不维护源码运行时包。
- `IAM/plugin/AlgorithmBridge/python/bridge.py` 是工具协议与程序执行入口，调用 `iam_algorithms`，不再维护一套算法绑定。
- `AlgorithmBridge/scripts/build.mjs host` 只构建插件 host，删除旧的 `python/vendor/`。`npm pack` 的 `prepack` 临时复制已通过独立导入验证的 `iam_algorithms` 二进制包、`iam` 和 schema，`postpack` 随即清理。打出的包仍可脱离源码树运行。

开发工作区使用 CMake 生成的包；bridge 和它启动的程序导入同一构建产物。可以用 `IAM_PYTHON_PACKAGE_DIR` 指定生成包或部署包的父目录。安装打包产物后，则从包内的 `python/vendor/` 导入。两者使用 `bridge.py` 中同一份路径顺序。

**而且它是个子进程**，理由和 `Import` 的一样：`iam_program_run` 执行的是**本仓库之外
的人写的代码**，它崩掉应该让这次工具调用失败，而不是让 agent 的会话失败。

### stdout 是协议

bridge 往 stdout 写**恰好一个 JSON 对象**，进度与拒绝写 stderr。这不是约定，是契约，
而且第一版就违反了它——流程自己的进度日志走到了 stdout，症状是一个 JSON 解析错误，
而那份文档除了开头两行中文之外完全合法。`host/python.ts` 的头注释记着这件事。

## 在 harness 里跑

```sh
cd D:/dev/MiningFlatform/iam-harness
pnpm dsh plugin --profile web add D:/dev/MiningFlatform/IAX/IAM/plugin/AlgorithmBridge
pnpm dsh --profile web --no-open --port 8899
```

若 profile 已安装 `@deepseek-ai/iam-mining-workspace`，它已经包含本插件的 bundle；
不要再单独添加 `@deepseek-ai/iam-algorithm-bridge`。重复 bundle 会产生两个同 ID 的
插件实例，profile 的 `config:` 可能只应用到其中一个，使 `iam_program_run`
仍被未配置的实例拒绝。移除重复的直接依赖后重启 Harness，并用
`pnpm dsh --profile web --dump-config` 确认只有一条 `iam-algorithm-bridge`
记录及其执行配置。

装完**要重启** `dsh web`：profile 的 bundle 列表是启动时读的。这个包没有 `dsh.client`，
所以没有 HMR——500ms 的轮询盯的是 `lib/client.js`，而它不存在。

`pnpm run dev:desktop` 使用独立的开发版 Desktop profile，默认位于
`iam-harness/apps/desktop/.desktop-build/development/home/profiles/desktop/`（若设置
`DSH_HOME`，则为 `$DSH_HOME/profiles/desktop/`）。Web profile 的修改不会传到
Desktop。该 profile 的 `package.json` 若已启用 `@deepseek-ai/iam-mining-workspace`，
应避免再次将 `@deepseek-ai/iam-algorithm-bridge` 列入 `dsh.profile.bundles`；在
`cordis.patch.yml` 给唯一的 `iam-algorithm-bridge` 条目配置 `programRunner`
或可信本地调试用的 `allowUnsafeExecution: true`。改完后完全退出并重新运行
`pnpm run dev:desktop`，不是重启 Web 服务。

配置项（`cordis.patch.yml` 里的 `config:`）：

```yaml
config:
  python: /usr/bin/python3            # 否则 $IAX_PYTHON，否则 python / python3
  timeoutSeconds: 300                 # 一次 iam_program_run 的上限
  pythonPath: [/extra/site-packages]  # 追加依赖路径；源码或打包绑定优先
  platformRoot: /opt/iax              # 独立安装时含 IAM/ 和 Mining/ 的目录
  programRunner: [/opt/iax/bin/iam-sandbox] # 生产环境执行用户代码的受限执行器
  workspace: /data/workspaces         # 无会话目录时的工作区根
```

## 用户流程：发现、隔离、固化

默认没有内置流程。`IAM/plugin/Workflows/` 里只剩 `Examples/ByProductOre`（样板与
回归夹具，放在 `*/manifest.json` 扫不到的一层），所以一个全新工作区的
`iam_workflow_list` 是空的；第一个能力由用户在工作区固化得到。这条线决定三件事。

**发现。** 两个根，先仓库后工作区：

```
IAM/plugin/Workflows/<名>/          provenance: builtin（默认没有；Examples/ 是夹具）
<工作区>/.iax/workflows/<名>/       provenance: workspace
```

**工作区是问出来的，不是配出来的。** harness 有 `ctx.workingDirectory`：按会话回答
这个会话在哪个目录里工作。插件的 host 半边通过一个可选接缝拿到它，`execute` 拿到的
`exec.agent` 就是那个会话：

```ts
const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
```

会话工作目录是首选边界，其次是 `config.workspace`。调用方给的 `workspace` 必须位于该边界内；
没有边界时，生产配置拒绝任意路径。`allowUnsafeExecution` 仅供可信本地调试。

`workingDirectory` 是**可选接缝而不是加载闸门**：写进静态 `inject` 就会让整个插件在
不挂会话目录的 profile 里装不上，而那正是 `headless` / `acp` 这两个最需要这些工具的 profile。
拿不到服务就退回配置，没有配置就只剩工作区里已经固化的流程；内置根默认不发现任何东西。

**来源由「在哪儿找到的」决定，不由 manifest 自己声明**——声明的东西可以被写错或写假，
位置不能。一个流程 = 一个目录 + `manifest.json`，加一个不需要构建、不需要装包、
不需要重启 harness。

两个根里同名，或同一个根下的两个目录同名 = **拒绝，不是覆盖**。事后没人分得清哪一份
在跑；悄悄选一个就是悄悄藏掉另一个。两个都该被说出来。

**隔离。** `workspace` 来源的流程进**孙进程**跑，`builtin`（`--directory` 指向的
测试夹具）在 bridge 进程里跑：

| 来源 | 在哪跑 | 为什么 |
|---|---|---|
| builtin | bridge 进程内 | 仓库代码/夹具，有契约有测试；拒绝就是异常，直接变成值交回去 |
| workspace | 外部受限执行器中的孙进程 | 用户代码不能仅凭子进程获得文件权限隔离 |

生产环境须配置 `programRunner: ["<sandbox-wrapper>"]`。执行器收到 Python 可执行文件和参数，
并通过 `IAX_EXECUTION_WORKSPACE` 得到本次会话已校验的工作区路径；须限制文件系统、网络、
进程与资源用量。未配置时生成程序及工作区工作流默认拒绝运行。
`allowUnsafeExecution: true` 仅用于可信本地开发。桥接进程还会剔除非必要环境变量、限制输出量，
并在取消或超时时终止进程树。

测试 `a workflow found in the workspace is run in a child, not in the bridge` 就是拿一个
`raise SystemExit(7)` 的用户流程去证明这条线还在。

**程序是一个文件，不是一个目录。** 这是被实测逼出来的一条形状。在 desktop harness 的
`workspace-write` 沙箱里（用 harness 自己的 runner 复现），被限制的子进程能建目录、能往里写，
随后**删不掉**：文件删不掉（`PermissionError`），目录也删不掉（`WinError 5 拒绝访问`），
而直接在授权根里建的文件删得掉。第一版每条程序建一个目录、交给 `TemporaryDirectory` 收尾，
于是「收拾房间失败」把一次**已经跑完、输出已经拿到**的运行变成了工具调用失败——一个实现细节
吃掉了答案。现在每条程序就是临时目录里的一个文件，跑完删掉；删不掉时结果里带一个
`leftover`（`{path, reason}`），把残留说出来而不是吞掉。

受沙箱限制的会话遇到别的拒绝（写不进工作区、列不出目录）时，harness 自带
`diagnose-windows-sandbox-acl` 技能可以诊断：那是沙箱的 ACL，不是这个插件的。

**固化。** 两步，刻意的：

1. **留痕**：`iam_program_run` 带工作区时，把程序与退出码写进
   `<工作区>/.iax/runs/<id>/`。不这么做，程序文本只活在对话记录里，「固化」就等于
   「再要一次」。留痕是**尽力而为**的：写不进去时结果里是 `recorded: false` 加原因，
   运行本身照常返回——实测受沙箱限制的会话写不进 `.iax/runs` 下**新建的**目录，
   而冻结需要一次留痕成功的运行。
2. **冻结**：`iam_workflow_freeze` 把一次成功留痕的运行 + 一份 manifest 写成
   `.iax/workflows/<名>/`。源码取自**实际跑过的那次运行**，不是调用方现在给的文本。
   `confirmed: true` 表示运行结果与验收规则已确认。`inputs` / `steps` / `acceptance` 缺一样就拒绝——一份由程序填出来的 manifest
   是一份没人意思过的 manifest（`Workflows/README.md` 立的门槛）。
   manifest 除这五节外还接受 `version` / `status` / `supersedes` / `requires_catalog` / `derived` / `consumes` /
   `produces` / `specs` / `acceptance_checks` / `acceptance_params` / `known_limits` / `deliverable`
   （含义见 `Workflows/README.md`）。**不认识的字段会被拒绝**并给出最接近的拼写：拼错的
   `acceptance_checks` 曾经能冻结成功，而那条断言从未存在——"验收通过"于是成了一句没人测过的话。
   `specs.*.default` 是相对流程目录的文件；bridge 只写 `workflow.py` 与
   `manifest.json`，`capability_freeze` 会把这些默认规范一起搬进冻结目录。

**草稿列得出来，跑不起来。** manifest 可以带 `status: "draft" | "active"`：
`iam_workflow_list` 每项返回 `status`，draft 排在 active 之后；`iam_workflow_run`
拒绝 draft，并提示「填好、先跑一次、再 freeze」。缺 `status` 的 manifest 一律按
active 处理，这是向后兼容——旧的流程与 `Examples/ByProductOre` 原样工作。
freeze 本身**保留**调用方给的状态：直接冻结一份 draft manifest，结果仍是 draft；
`CapabilityForge` 的 `capability_freeze` 先以 draft 交给 bridge，锁写好后最后写
active。状态不由冻结层替调用方猜。

## 推不出来的参数：问，不要猜

这是这一层最容易被做错的地方，所以工具说明里写死了。

平台记的是**字段名与值类型**，不记「这些数是什么意思」。参考模型里每一个字段声明的单位
都是 `1`、描述为空——包括 CU。所以「哪一列是品位」「它的数是比例还是百分数」**推不出来**，
而没有一样能猜对：把百分数列按比例读，金属量高一百倍，而表看上去毫无异样。

harness 已经有 `ask_user_question`（`packages/interaction/tool-ask-user`，走 `ctx.userQuestions`，
已经装在 web profile 里），所以链条是：

```
iam_mine_describe   →  每个列的 field_name / value_type / numeric   ← 用户能选的选项
iam_workflow_run    →  拒绝，并说清缺什么                          ← 要问什么
ask_user_question   →  带着上面的真实选项问用户                     ← 谁回答
iam_workflow_run    →  用答案重跑
```

`iam_mine_describe` 的返回里还有一条 `field_names_are_not_semantics`，把这个边界直接写在
数据里，省得模型去找不存在的语义。

**为什么不在这里替模型问**：`ask_user_question` 是**面向模型**的（它拿得到对话上下文、
用户的语言、以及该给出哪些选项），而 bridge 跑在子进程里，本来也问不了。工具能做的是
**让问题问得出来**——给出字段名，和一句「推不出来就问」。

## 工具的返回契约：值是值，不是信封

`execute` 返回**值本身**，`output.render(args, value)` 把它变成卡片上的文本块。
**不要返回 `{ content, isError }`**——那是 MCP 的信封，第一版就是这么写的，
harness 在 `content.some is not a function` 上炸了：它看见一个带 `content` 成员的对象，
当成信封收下，然后对里面的东西调了数组方法。

失败分两种，这个包按 `Import` 的成法分开：

| 情况 | 怎么走 |
|---|---|
| 流程拒绝（数据问题） | **值**：bridge 以 0 退出并给出 `{ok:false, refused:"..."}`，模型读得到、能自己纠正 |
| 答不出来（库没装、id 不存在、动词不认识） | **抛 Error**：bridge 非 0 退出，harness 把消息当成工具错误显示 |
| 退出码 0 但 stdout 不是 JSON | 也抛——那是 bridge 的缺陷，不是调用方的 |

测试同时驱动 `execute` 与 `render` 两半，就是为了这个：只读 `result.content[0].text`
的测试会把上面那个 bug **固化**成契约，而不是抓住它。

## 四个刻意的取舍

1. **不用 `defineTool`。** 它在 `@deepseek-ai/dsh-tools` 里，而这个 host 半边在运行期
   不能 import 任何 `@deepseek-ai/*` 的值：`dsh plugin add` 把包软链进一个
   `node_modules` 里只有被链插件的 profile。代价是工具自己负责入参校验——`tools.ts`
   里的 `requireString` 就是那个。
2. **没有 `Config` schema。** 同理，`@deepseek-ai/schemastery` 也 import 不了。Cordis 在
   没有 schema 时把 row 的 `config:` 原样传下去，所以字段带兜底读，类型错误在调用点
   是 TS 错误而不是加载期拒绝。
3. **没有 client 半边**，所以没有 `vendor/`、没有 `package.json` 的 `dsh.client`。
   这正是它能在 `headless` / `sdk` / `acp` 下加载的原因——那三个 profile 不挂浏览器，
   而 `Views` 那样的包在那里根本装不上。
4. **`python/bridge.py` 不编译。** 它按源码发布；构建阶段复制匹配的 Python 绑定和内置工作流。
   原生动态库仍由 `platformRoot` 下的构建产物或 `IAM_ALGORITHMS_LIBRARY`、
   `IAM_C_LIBRARY` 指定，不会凭空随 npm 包产生。

## 测试

多材料闭合轮廓插值的直接入口为
`iam_algorithms.modeling.interpolate_contours`，可通过
`iam_algorithm_search` / `iam_algorithm_describe` 查找
`geometry.section.interpolate_contours`。该入口不使用 `Library.invoke`。
输入契约、分辨率限制及实测拒绝案例见
[`SECTION_CONTOUR_INTERPOLATION.zh-CN.md`](../../Algorithms/SECTION_CONTOUR_INTERPOLATION.zh-CN.md)。

轮廓对应、周期曲线正则、
距离索引及批量查询均由正式目录暴露，目录声明 `call_kind: direct` 与
`iam_algorithms.modeling` 下的具名函数。距离查询也支持 `index.query_distances(points)`。
索引仅在当前 Python 进程有效，建树与多次查询应放在同一次程序执行内。
算法前置条件、资源限制和实测见
[`MODELING_KERNELS.zh-CN.md`](../../Algorithms/MODELING_KERNELS.zh-CN.md)。

上述六个条目（断面插值、断面重建、四个建模内核）的 `entry.doc` 已按
`geometry.polygon.boolean` 的格式写明：入口、输入结构、坐标系与单位、容差、默认值、
结果访问方式、限制和拒绝消息，并各带一段可执行 Python 示例。`iam_algorithm_describe`
直接返回这段文本，所以生成参数前先读它；不要从 `python_name`、`c_symbol` 或实验脚本
里的调用片段反推参数和单位。

```sh
node IAM/plugin/tests/run.mjs          # 全套，含本包的 12 项
node --test IAM/plugin/tests/bridge-tools.test.mjs
```

测试把插件挂在一个 `fakeTools()` 上，然后**调用**它的定义（含 `execute`），
所以验的是 profile 真正加载的那份产物。需要已构建的平台与
`D:/dev/MiningFlatform/workspace/test1.iam` 的那几项会 skip 而不是失败——
一个因为读者没编 C++ 就变红的测试，会训练人忽略红色。

### 全栈高分辨率与无损分文件

普通原生建模入口 `geometry.surface.build_contour_model` 可显式设置
`resource_profile="large"`，用临时文件映射保存全栈 binary64 分数，
保留全部迁移站点、公共界面和精确几何认证。支持 `padding=0..64`（整数，默认 2，0 也表示 2）；
large 的完整迁移表上限为 10 亿节点、80 亿分数，最多约 64 GB 分数临时文件。直接 `reconstruct_contours`
和变分求解器仍保持原预算。需要原始面片时传 `simplify=False`；
`output_layout="bundle"` 配合新的 `.iamset` 输出目录，可在整体验证通过后
按材质无损分文件：每种材质恰好一个完整 IAM，保留跨全部剖面的完整网格及原始索引，不按剖面、空间或面数再切分。
每个完整材质 IAM 现支持最多 2000 万顶点/4000 万三角形，未压缩载荷上限 1536 MiB；读写和完整回读验证使用同一计数预算。
资源边界、调用及格式见[高分辨率说明](../../Algorithms/docs/large_contour_models_20261116.zh-CN.md)。
内存布局、分页分配及完整重放测量见[内存优化记录](../../Algorithms/docs/contour_memory_optimization_20261116.zh-CN.md)。
