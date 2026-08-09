# 构建插件并部署到测试 Vault（复制 main.js + manifest.json，不覆盖 data.json / state.json）
# 注意：A/B 双 Vault 测试必须用复制而不是 junction 链接——
# 插件目录里的 state.json 保存 deviceId / lastSequence，两个 Vault 共享会破坏双设备模拟。
# 用法：.\scripts\dev-deploy.ps1
param(
    [string[]]$Vaults = @(
        "D:\dev\obsidian\SyncDevVault-A",
        "D:\dev\obsidian\SyncDevVault-B"
    )
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

Push-Location $repo
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "plugin build failed" }
    foreach ($vault in $Vaults) {
        $pluginsDir = Join-Path $vault ".obsidian\plugins"
        $dst = Join-Path $pluginsDir "litesync"
        $old = Join-Path $pluginsDir "obsidian-private-sync"

        # v7 插件 ID 迁移：obsidian-private-sync → litesync
        # 整目录改名保留 data.json（设备密钥）与 state.json（deviceId / 游标），
        # 并更新 community-plugins.json 中的启用 ID
        if ((Test-Path $old) -and -not (Test-Path $dst)) {
            Move-Item $old $dst
            Write-Host "migrated plugin dir -> $dst" -ForegroundColor Yellow
        }
        $cpJson = Join-Path $vault ".obsidian\community-plugins.json"
        if (Test-Path $cpJson) {
            $ids = @(Get-Content $cpJson -Raw | ConvertFrom-Json)
            if ($ids -contains "obsidian-private-sync") {
                $ids = @($ids | ForEach-Object { if ($_ -eq "obsidian-private-sync") { "litesync" } else { $_ } } | Select-Object -Unique)
                ConvertTo-Json $ids | Set-Content $cpJson
                Write-Host "updated community-plugins.json (id -> litesync)" -ForegroundColor Yellow
            }
        }

        New-Item -ItemType Directory -Force $dst | Out-Null
        Copy-Item main.js, manifest.json, styles.css -Destination $dst -Force
        Write-Host "deployed -> $dst" -ForegroundColor Green
    }
    Write-Host "完成。在 Obsidian 中 Ctrl+P -> 'Reload app without saving' 重新加载插件。" -ForegroundColor Yellow
}
finally {
    Pop-Location
}
