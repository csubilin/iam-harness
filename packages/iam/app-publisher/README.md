# AppPublisher — 把能力发布成桌面 APP

一个 host-only `tool` 插件：把工作区里**已冻结**的能力（`.iax/workflows/<name>/`）
连同基础可执行文件、`bridge.py`、绑定和 Python 运行时复制成一个可移植文件夹。

**能力是数据，发布就是一次文件复制。** 第二个 APP 不需要重新构建，只是换一份
选择；安装包、签名、升级和卸载都不在这一步，输出是一个文件夹（可选再压成 zip）。

| 工具 | 做什么 | 不做什么 |
|---|---|---|
| `iam_app_publish` | 围绕 `IamMining`（默认）或 `IamDrawing` 组装发布目录并写 `iam-app.json` | 不构建、不冻结、不运行能力 |

发布目录的形状：

```
<out>/
  IamMining.exe + 同目录 DLL
  Fonts/  resource/                  （部署里存在时）
  workflows/<name>/manifest.json + workflow.py
  python/bridge.py
  python/vendor/iam_algorithms
  python/vendor/iam
  python-runtime/                   （可移植解释器）
  workspace/
  iam-app.json                       （Ribbon 描述，schema 1）
  publish.json                       （工作流与哈希的回执）
```

## 规则

- **只有 active 的流程能发布。** draft 会被拒绝：它还没填完，平台本身也拒绝运行；
  manifest 缺少标题/说明、输入对话框画不出来、程序文件不存在，都是拒绝。
- **`workflows` 的顺序就是 Ribbon 顺序。** 不传则发布工作区里全部 active 流程，
  按名字排序。
- **`out` 按 workspace 解析，且必须留在 workspace 内**；workspace 根、`.git`、
  `.iax`、`.agents` 本身不允许被替换。已存在且非空的目录需要 `force` 才替换。
- 发布出的 APP 通过 `python/bridge.py` 直接运行流程：**不需要 Harness 安装，也不需要模型端点**。
- 运行时必须自带流程 `import` 的包（例如 numpy）；平台自己的 `iam/`、`iam_algorithms/`
  和 `bridge.py` 由发布器复制，不会从目标机借用。
- 相对路径与解释器都不猜：缺哪个就点名哪个。

## 来源（环境变量或 row 的 `config:`）

| 需要 | 默认 |
|---|---|
| 基础 APP 与 DLL | `IAM_NATIVE_DIR`，否则同级 IAX 的 `build/exe/<platform>` |
| 字体 / 图标资源 | `IAM_FONTS_DIR` / `ACAD`；`IAX_RESOURCE`，否则基础 APP 同目录的 `resource` |
| `bridge.py` | `IAM_BRIDGE_SCRIPT`，否则同级 `algorithm-bridge/python/bridge.py` |
| `iam_algorithms` / `iam` | `IAM_PYTHON_PACKAGE_DIR` / `IAM_MINING_PYTHON_DIR`，否则 `bridge.py` 旁的 `vendor/`，再否则 IAX 构建目录 |
| Python 运行时 | `IAX_APP_PYTHON_DIR` 或 `IAM_BRIDGE_PYTHON`（目录或其中一个解释器） |

打包后的 Desktop 已经在 `main.ts` 里设好这些变量，所以安装版里发布不需要额外配置。
`config:` 优先于环境变量；解释器必须是可移植目录，裸 `python` 名字会被拒绝。

## 命令行等价物

```sh
pnpm run package:app -- --base mining --workspace <dir> --out <dir> [--workflows a,b] [--zip]
```

`scripts/publish-app.ts` 是同一个 `publish()` 的命令行入口，两者共用
`host/publish.ts`，不存在第二份实现。

## 测试

```sh
node --test packages/iam/tests/app-publisher.test.mjs
```

测试把工具挂在假 `ctx` 上并调用：拒绝 draft、Ribbon 顺序、输出布局、`force`
与越界拒绝都在这里；`scripts/publish-app.spec.ts` 覆盖复制核心本身。
