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

Push-Location (Join-Path $repo "plugin")
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "plugin build failed" }
    foreach ($vault in $Vaults) {
        $dst = Join-Path $vault ".obsidian\plugins\obsidian-private-sync"
        New-Item -ItemType Directory -Force $dst | Out-Null
        Copy-Item main.js, manifest.json, styles.css -Destination $dst -Force
        Write-Host "deployed -> $dst" -ForegroundColor Green
    }
    Write-Host "完成。在 Obsidian 中 Ctrl+P -> 'Reload app without saving' 重新加载插件。" -ForegroundColor Yellow
}
finally {
    Pop-Location
}
