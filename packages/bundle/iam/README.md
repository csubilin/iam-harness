# mining-workspace — 组装 bundle

装一个包等于装齐整套：

```sh
pnpm dsh plugin --profile web add <repo>/IAM/plugin/profile/mining-workspace
```

它自己不含代码，`package.json` 的六个本地依赖随安装进入 profile，补丁再插入对应六行。
当前 `file:` 依赖只适合本地源码安装；发布到制品库时须改成六个已发布包的版本依赖。
安装前先构建六个插件包及 C++ 原生库。桥接包会携带匹配的 Python 绑定与内置工作流；
运行时通过 `IAX_PLATFORM_ROOT` 或桥接插件的 `platformRoot` 指向含原生库构建产物的 IAX 根目录。
`dsh.bundle.patch` 指向的 `cordis.patch.yml` 就是它的全部实质，
`src/index.js` 只有一句 `export {}`。

## 为什么用 JavaScript 而不是 TypeScript

这个包里没有任何逻辑。别的包要编译是因为它们有代码；
为了产出 `export {}` 而养一个构建脚本，是在为一个空的东西付维护成本。
如果它将来长出 `apply()`，就按邻居的样子改成 TypeScript。

## 新增模块时

`manifest.json` 是清单：插件包、类型、来源、状态都记在那里。
新增一个包时先在那里登记一行，再决定要不要进这个 bundle——
进 bundle 意味着「有工作空间的场景都需要它」，而不是「它已经能用了」。
