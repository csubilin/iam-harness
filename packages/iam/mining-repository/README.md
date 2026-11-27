# MiningRepository — 一扇读写门，两半都开了

**状态：读写两半都在。** 一个能装进 profile 的 host-only 工具包，四个工具：读的
`iam_mining_show`，写门的 `iam_mine_edit` / `iam_mine_verb` / `iam_mine_apply`。

写门的形状只有一句话：**编辑不发布**。改一个矿是一条平台校验后提交的 delta，
所以两个编辑工具产出的是 `.iaxd` **文档**，`iam_mine_apply` 才把它提交成下一条
修订。中间那一步就是"可以先被人读一遍"，也是这个插件为什么改不动一个矿。

## 已经做出来的那一半：让面板只画被点名的东西

**面板打开的是真文档，不是副本。** `iam_mining_show` 解析选择（元素 id 是否真的
存在、叫什么），然后把**源文件自己**交给面板；视图那边被单独告诉"只显示这些"
（`IamView::setVisibleSelection`），镜头随之对准选择。所以：

- 不生成第二份数据，不新开标签页，不重启渲染引擎；
- 同一个文档再换一个选择（「显示矿体」→「显示巷道」）是**同一个面板**上换一次
  显示，因为侧栏对已有的地址是聚焦而不是新开；
- 源项目**只被读**。

**两种容器，两种去处**（用户在 `.iam` / `.iamh` 两种存储设计下定的分工）：

| 容器 | Web | desktop |
|---|---|---|
| `.iam`（便携） | 面板打开 + 自动隔离/取景 | 同左 |
| `.iamh`（列存） | **具名拒绝**：wasm 不链 HDF5，读不了 | 工具**直接起 `IamMining.exe`**，经 `IAM_ISOLATE` 传同一个选择；同一文档只开一个原生窗口，重复调用被拒绝 |

**已知且已知情的代价**：面板要把整份文档拷进 wasm 堆再解压解码（参考矿 31 MB 文件 /
158 MB payload），所以第一次打开偏慢；显示开关省的是"画"，不是传输与解码。这是
"不在工作区里生成数据副本"换来的，是用户的取舍，不是我漏掉的事。

**但"画"这一半从一开始就省掉了**：选择在 attach 里生效，所以第一个显示文档的帧就是
隔离后的（实测 48.4% 空，整份是 40.4%），块段模型的边界网格预热也会跳过隐藏的模型。

**线的格式**：`IamView::setVisibleSelection` 收 UTF-8，一行一个条目——元素 id
（该元素的全部几何），或 `元素id + 0x1F + 几何id`（只这一个几何）。空串 = 显示全部。
分隔符就是视图自己的 `sceneItemKey` 用的那个；不做 JSON，因为视图库没有解析器。

## 已经做出来的另一半：写门

四个工具，**两个出口、一个读口、一个落点**：

| 工具 | 输入 | 结果 |
|---|---|---|
| `iam_mine_edit` | `put` / `attach` / `erase` 的声明式描述 | `.iaxd` 文档，**不发布** |
| `iam_mine_verb` | 定义 `run(port)` 的 Python | `.iaxd` 文档，**不发布** |
| `iam_mine_document` | 一份文档 | 它要动什么：**逐个资源 id**、目标修订、契约版本 |
| `iam_mine_apply` | 一份文档 | 提交成下一条修订，**默认原地** |

`iam_mine_document` 是评审门中间那一段，而且它**不要项目** —— 文档自己写着它是给谁的，
而拿到一份别人给的编辑时第一个问题是"这是给这个矿的吗"，文档头就能回答，不用打开任何一个。
它报的是 **id 不是计数**：`replaces surfaces s-1, s-2` 是可以点头的，`2 个面` 不是。
`resources: true` 再带上文档自己的 JSON，于是能看见**新的值**（坐标、属性行、名字）而不只是
哪些资源会动；文档大到带不动时它会说清楚并给出文件路径，而不是递给你半截 JSON。

两个编辑口的分工是"要不要跑一段程序"，而那是**沙箱差别**，所以是两个工具而不是
一个工具的开关：声明式的那个跑的是本包自己的 `apply_edit.py`，不需要沙箱；动词那个
跑的是这次会话写出来的代码，必须有 `programRunner` 才肯跑（拒绝语里也写了哪个工具
不需要沙箱）。两者产出的都是同一个 delta —— `put`/`attach`/`erase` 累积成**一次**
编辑，可达性只在提交结果上检查一次，所以"先造几何、再挂到元素上"这种自然写法才成立。

**文档默认落在项目旁边**（同名换 `.iaxd` 后缀）。这不是随手选的：能写项目就一定
能写它旁边，而一个固定子目录需要被创建、且可能被只读父目录或只允许一层的沙箱拒绝
（那个失败在 `AlgorithmBridge/python/bridge.py` 里已经实测过一次）。`--document`
可以指到别处。

**底座一行没重写。** 三个动词都只是启动平台自己的无界面宿主
`python3 -m iam.host`：截止时间、delta 预算、ABI/schema 协商、`--emit-delta`
评审门全在它里面，本包只负责 CLI 的翻译和 JSON 的读回。编辑完成后文档是**读回来**
的——报告里的 `changes` / `erased` 来自文档自己的字节，而不是编辑时的记忆，所以一份
没带上本该带的东西的文档会报告出这个差别，而不是把它藏起来。

**apply 之后会重新打开写出来的文件**读修订号，而不是算 `revision + 1`：那是平台
的规则，在这里再说一遍就成了第二个说法；而且对"原地覆盖"来说，唯一的证据就是写出去
的字节能被重新读回来。

### 唯一写入口在 C ABI 上补的那一处

写门落地时暴露了一个平台缺口：**C ABI 一直只能存便携 `.iam`**（`iamSnapshotSaveFile`
只调 `IamFileStore::save`），而两种容器**读**都支持。所以一个刚打开的 `.iamh`
写不回去，失败的样子是"一个 `.iam` 被写到了要列存的地方"。
`iamSnapshotSaveFileAs(handle, filename, container, …)` 补上了列存那一支，
`iamSnapshotSaveFile` 保留原义不变。

### 为什么是 tool 而不是当初预留的 service

manifest 对 service 的定义是"别的包调用它，模型不直接调它"，而写门**必须**由模型
调。真出现第二个消费者（ArtifactStore，或某个工作流拿子集当中间产物）时再补 service
面；在那之前它只是一个没有调用者、也没有自己的修订语义要维护的第二个入口。

## 结构

```
host/{index,tools,python,native}.ts  host 半边：注册工具、解析选择、spawn Python、起原生编辑器
python/repository.py                 被 spawn 的 CLI：resolve / edit / verb / apply
python/apply_edit.py                 写门声明式那一口的动词，由 iam.host 运行
scripts/build.mjs                    只出 host 半边；把 iam 拷进 python/vendor
```

```sh
node scripts/build.mjs host
python python/repository.py resolve --project <mine.iam> --element <id> --workspace <ws>
```

### 派生文档那一版留在历史里

上一轮的做法是"把选择写成一份新的小 `.iam`"（`subset.py` + 它的 26 项测试），
用户的设计修订之后它成了死代码，**已经删除**。要看它：`git show e9b3feb4 --
IAM/plugin/MiningRepository/python/subset.py`。

## 客户端那半边在 Views 里

卡片（以及"自动打开面板"）由 `Views` 的客户端渲染，数据来自**工具结果的
presentation metadata**——它随会话日志持久化，重载后同一份字节复原同一张卡。
选择则由 `Views` 自己的一张内存表按地址交给面板（harness 的 `file` params 属于
文档预览包，另一个包不能往同一个键上加字段）。

**因此本仓库的测试只覆盖到 host 半边与无 React 的那部分**：`IAM/plugin/tests/` 里
没有 React、没有 jsdom、没有 shell 挂载表，所以画卡片那个组件、以及面板里"读到选择
就调用视图"的那段 effect 在这里是不被覆盖的——它们的手算部分（meta 校验、地址拼装、
哪些调用该自动打开、选择表）全在无 React 的 `client/core/mining-show.ts` 里被
`mining-show.test.mjs` 驱动。

**视图那一侧另有验证**：重建 wasm 后可以用 headless/WINDOWED Chrome 打开真项目、
调用 `_iamSetVisibleSelection`、读画布像素来确认"只画了选择"——判据是
**视口里空出来的比例**（整份 36.85% → 只显示矿体 59.45% → 都不匹配 63.01% →
恢复 45.54%），因为隔离会同时移动镜头，"画了多少像素"说明不了任何事。
