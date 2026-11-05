# 更新检测（Update feeds）

> 目标（用户口径）：任务包发布之后，使用端能像「软件检测到更新」一样发现它；
> 来源可以是**远程网页（GitHub raw / GitHub Release / 静态站点）**，也可以是**本地目录**。
> 本功能当前在 `passioki/oas-core` 实现（seq 114）；本仓 Phase 1 搬迁后会移到这里。

## Runner 配置（`config/live.json`）

```json
{
  "updates": {
    "enabled": true,
    "fetch_timeout_ms": 8000,
    "feeds": [
      {
        "name": "github",
        "enabled": true,
        "index_url": "https://raw.githubusercontent.com/<owner>/<repo>/main/publish-index.json",
        "package_base": "https://github.com/<owner>/<repo>/releases/download/v0.2.0"
      },
      {
        "name": "shared-local",
        "enabled": true,
        "index_url": "D:/OAS-shared/feed/publish-index.json",
        "package_base": "D:/OAS-shared/feed"
      }
    ]
  }
}
```

- `index_url`：本地 JSON 路径（相对 `config/live.json` 目录）或 `http(s)` URL。
- `package_base`：本地目录或 URL 前缀；留空时事件必须带完整 `package_url`。
- 索引格式 = Studio exchange 的 `publish-index.json`（schema 1；事件可含
  `package_url` / `min_engine` / `flow_ops`）。`GET /runner/updates` 会合并
  exchange + 所有 feeds，并给出 `source` / `source_kind` / `download_required`；
  远程事件点「安装」会走 `POST /runner/updates/install {event_id}`。

## 生成 feed（在 oas-core 仓库）

```powershell
# 1) 发布任务包（Studio）
target\debug\oasd.exe studio publish --task <任务id>

# 2) 生成 feed（可直接上传到 GitHub Release / 静态站点）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-update-feed.ps1 `
  -PackagesDir dist\packages `
  -OutFile dist\feed\publish-index.json `
  -PackageBaseUrl "https://github.com/<owner>/<repo>/releases/download/v0.2.0" `
  -CopyPackages
```

`-CopyPackages` 会把 `.oaspkg` 一起放进 `dist\feed\`，便于整体上传；也可以手工把
`.oaspkg` 传到 GitHub Release，把 `publish-index.json` 放到仓库 / GitHub Pages / raw URL。

## 下载实现（已决定）

HTTPS 下载使用**系统 `curl`**（Windows 10+ / macOS / Linux 自带），不引入 TLS 依赖：

```
curl -fsSL --max-time <fetch_timeout_ms/1000> --max-filesize <limit> -o <tmp> <url>
```

- 远程包必须带 64-hex `sha256`，下载后做 size + sha256 双重校验；不匹配会删除缓存并
  返回错误（不会安装）。
- 索引大小上限 2 MiB；包大小上限 512 MiB；缓存位于 `packages/remote/`。
- 无 curl / 无网络 / 私仓 token 场景：URL feed 会 fail-soft（页面提示），本地目录与
  exchange 不受影响。

## 已知限制（下一步）

- URL feed 目前**没有 TTL 缓存**：Runner 每次刷新都会重新拉取（UI 约 5 s 轮询）。
  计划：后端缓存 ≥60 s 或 UI 降频。
- 不支持私有仓鉴权 / 自定义 header / 代理配置（curl 默认沿用环境代理）。
- `packages/remote/` 暂不自动清理（可手动删除）。
- Android 使用端需要替换 HTTP 栈（设计预留）。
