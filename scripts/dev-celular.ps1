# Religa o app dev no celular depois que o cabo sai.
#
# Os tuneis do `adb reverse` morrem junto com a conexao USB, e sem eles o app
# nao alcanca nem o front (vite), nem o Metro, nem o backend — o sintoma e
# "Nao foi possivel conectar ao servidor" no login. Nao precisa rebuildar: o
# APK continua instalado, so as portas encaminhadas caem.
#
# Uso: powershell -ExecutionPolicy Bypass -File scripts\dev-celular.ps1

$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$pacote = 'br.com.dunorte.vexo'

# 8080 = vite (front), 8081 = Metro (bundle do wrapper), 3000 = backend
$portas = 8080, 8081, 3000

if (-not (Test-Path $adb)) {
  Write-Host "adb nao encontrado em $adb" -ForegroundColor Red
  exit 1
}

if (-not (& $adb devices | Select-String "`tdevice$")) {
  Write-Host "Celular nao conectado. Religa o cabo e autoriza a depuracao USB." -ForegroundColor Yellow
  exit 1
}

foreach ($porta in $portas) {
  & $adb reverse "tcp:$porta" "tcp:$porta" | Out-Null
  # Avisa se o servico do lado do notebook estiver fora: o tunel sobe do mesmo
  # jeito, mas o app vai falhar ao usar a porta.
  $conectou = (Test-NetConnection -ComputerName localhost -Port $porta -WarningAction SilentlyContinue).TcpTestSucceeded
  $estado = if ($conectou) { 'OK' } else { 'servico FORA do ar no notebook' }
  $cor = if ($conectou) { 'Green' } else { 'Yellow' }
  Write-Host ("tcp:{0} -> {1}" -f $porta, $estado) -ForegroundColor $cor
}

& $adb shell monkey -p $pacote -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
Write-Host "App aberto no celular." -ForegroundColor Green
