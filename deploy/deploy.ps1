# 로컬 PC 에서 실행: 운영 빌드 후 Lightsail 인스턴스로 복사하고 서비스를 재시작한다.
#   .\deploy\deploy.ps1 -HostName 1.2.3.4 -KeyPath $HOME\.ssh\license_tutor_lightsail
param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [string]$User = "ubuntu",
    [string]$KeyPath = "$HOME\.ssh\license_tutor_lightsail",
    [string]$RemoteDir = "/opt/dopamine-loop"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = "$User@$HostName"

Push-Location $root
try { cmd /c "npm run build 2>&1"; if ($LASTEXITCODE -ne 0) { throw "build failed" } } finally { Pop-Location }

# 빌드 결과와 실행에 필요한 파일만 올린다. node_modules 는 서버에서 npm ci 로 설치한다.
$items = @("dist", "deploy", "package.json", "package-lock.json", "README.md")
ssh -i $KeyPath $target "sudo mkdir -p $RemoteDir; sudo chown $User`:$User $RemoteDir; rm -rf $RemoteDir/dist"
foreach ($i in $items) {
    scp -i $KeyPath -r (Join-Path $root $i) "$target`:$RemoteDir/"
}
ssh -i $KeyPath $target "cd $RemoteDir; if systemctl list-unit-files dopamine-loop.service >/dev/null 2>&1 && command -v node >/dev/null; then npm ci --omit=dev --no-audit --no-fund --loglevel=error; sudo systemctl restart dopamine-loop; sudo systemctl --no-pager --lines=5 status dopamine-loop; else echo '최초 설치: sudo bash deploy/setup-server.sh <도메인>'; fi"
