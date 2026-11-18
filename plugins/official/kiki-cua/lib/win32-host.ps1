param(
  [Parameter(Mandatory = $true)]
  [string]$CsPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

$refs = @(
  'System',
  'System.Core',
  'System.Drawing',
  'System.Windows.Forms',
  'UIAutomationClient',
  'UIAutomationTypes',
  'WindowsBase',
  'System.Web.Extensions'
)

$csCode = [System.IO.File]::ReadAllText($CsPath, [System.Text.Encoding]::UTF8)
Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -Language CSharp

$inReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$outWriter = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8NoBom)
$outWriter.AutoFlush = $true

$outWriter.WriteLine([KikiCua.NativeBridge]::BuildReadyLine($PID))

while ($true) {
  $line = $inReader.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $shouldExit = $false
  $resp = [KikiCua.NativeBridge]::HandleRpcLine($line, $PID, [ref]$shouldExit)
  $outWriter.WriteLine($resp)
  if ($shouldExit) { break }
}

[KikiCua.NativeBridge]::ReleaseAllInputs()
