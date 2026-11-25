# Agent Note: IAM 矿山插件只保留一处源码

Status: implemented

[English](2026-11-25-iam-plugins-single-source.md) | 中文

## 问题

IAM 矿山插件原先在独立的 IAX 仓库 `IAM/plugin` 下开发，又被复制到本仓库的 `packages/iam`，以便产品把它们作为内置 profile bundle 分发并默认启用。两份副本已经分叉：本仓库使用带作用域的包名、`prepack` 脚本和包内 workflows 源，而 IAX 仍按旧布局构建。手工复制会覆盖任何一侧的改动。

## 决策

本仓库的 `packages/iam` 是唯一源码。IAX 只保留平台部分（wasm 视图源码、原生库、Python 算法、`Host`/`ViewCore`），并在 `IAM/plugin/README.md` 留下指针。它的 `build.sh`/`build.ps1` 把插件构建委托给本仓库（`IAM_HARNESS_ROOT`，默认 `../iam-harness`），node:test 套件也迁到 `packages/iam/tests`（`pnpm run test:iam`）。

唯一仍跨仓库的生成物是 wasm 视图产物。`pnpm run sync:iam-views` 把 `IamDrawingView.*` 和 `IamMiningView.*` 从 IAX 构建目录（`IAX_WASM_VIEWS`，默认同级 `IAX/build/bin/wasm/views`）复制到 `packages/iam/views/vendor`；`pnpm run check:iam-views` 比较已提交的副本，并纳入 `iam` 构建 gate。两者在没有 IAX 构建树时都会跳过。IAX 的 `build.sh build web` 已在构建过程中执行同一次复制。

## 影响

插件改动在本仓库完成和测试；IAX 平台重建会自动刷新 vendored 视图，或报告漂移。插件源码不再跨仓库重复。构建 IAX 的 `web` 目标现在需要本仓库（或 `IAM_HARNESS_ROOT`）；同级 IAX 检出和 `IAX_PLATFORM_ROOT` 都不存在时，平台相关测试会跳过。`pnpm run package:iam` 生成包含这些插件的完整安装包：默认未签名，配置好发布签名环境后可用 `--signed`。
