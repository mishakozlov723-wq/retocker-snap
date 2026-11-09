# Smoke test on the build machine: start the app, open every settings page, take a test shot,
# select an area in the overlay. Screenshots and the app's log end up in the ci-shots branch.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
New-Item -ItemType Directory -Force shots | Out-Null
function Log($s) { $s | Tee-Object -FilePath smoke.txt -Append }
function Shot($n) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
  $bmp.Save("shots/$n.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
# CPU of the app and its WebView over a few seconds, % of the whole machine, and memory
function Cpu($label, $sec = 5) {
  $names = @('retocker-snap', 'msedgewebview2')
  $a = (Get-Process -Name $names -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum
  Start-Sleep $sec
  $ps = Get-Process -Name $names -ErrorAction SilentlyContinue
  $b = ($ps | Measure-Object CPU -Sum).Sum
  $pct = [math]::Round(($b - $a) / $sec / [Environment]::ProcessorCount * 100, 1)
  $ram = [math]::Round(($ps | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
  $flag = if ($pct -gt 12) { '  <-- HIGH' } else { '' }
  Log "cpu ${label}: $pct% ram $ram MB$flag"
}
function Key($vk, $up) { [W]::keybd_event($vk, 0, $(if ($up) { 2 } else { 0 }), [UIntPtr]::Zero) }
function Vis($t) { $h = [W]::FindWindow([NullString]::Value, $t); if ($h -eq [IntPtr]::Zero) { 'none' } else { [W]::IsWindowVisible($h) } }

$exe = (Resolve-Path "src-tauri/target/release/retocker-snap.exe").Path
Log "exe: $exe ($((Get-Item $exe).Length) bytes)"
$env:RA_DEBUG = '1'
$p = Start-Process $exe -PassThru
Start-Sleep 12
Shot "01-start"
Log "settings visible: $(Vis 'Retocker Snap')"
Cpu 'settings open'

$pages = @('home', 'sel', 'bg', 'help', 'after', 'save', 'text', 'keys', 'hist', 'app')
$i = 10
foreach ($pg in $pages) {
  Start-Process $exe -ArgumentList '--test-page', $pg | Out-Null
  Start-Sleep -Milliseconds 2200
  Shot "$i-page-$pg"; $i++
}

# the overlay: open it, wait for the intro, then select an area from the test hook
Start-Process $exe -ArgumentList '--test-shot', 'area' | Out-Null
Start-Sleep -Milliseconds 2500
Log "overlay visible: $(Vis 'Retocker Snap — выделение')"
Shot "30-overlay"
[W]::SetCursorPos(500, 400) | Out-Null; Start-Sleep -Milliseconds 800
Shot "31-hover"
Start-Process $exe -ArgumentList '--test-sel', '200,150,700,420' | Out-Null
Start-Sleep -Milliseconds 1500
Shot "32-selected"
# Enter = copy
[W]::keybd_event(0x0D, 0x1C, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::keybd_event(0x0D, 0x1C, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 700
Shot "33-after"
Start-Sleep -Milliseconds 1800
Shot "34-card"
Log "card visible: $(Vis 'Retocker Snap — снимок')"
$img = [System.Windows.Forms.Clipboard]::ContainsImage()
Log "clipboard has an image: $img"

# the round menu: switch it on, select an area, look at it, close it, switch back
Start-Process $exe -ArgumentList '--test-cfg', 'toolbar=radial' | Out-Null
Start-Sleep -Milliseconds 800
Start-Process $exe -ArgumentList '--test-shot', 'area' | Out-Null
Start-Sleep -Milliseconds 2200
Start-Process $exe -ArgumentList '--test-sel', '300,200,640,380' | Out-Null
Start-Sleep -Milliseconds 1600
Shot "37-radial"
Log "radial: card visible $(Vis 'Retocker Snap — снимок') (should be False)"
[W]::keybd_event(0x1B, 0x01, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::keybd_event(0x1B, 0x01, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900
Shot "38-radial-closed"
Log "overlay after Esc: $(Vis 'Retocker Snap — выделение')"
Start-Process $exe -ArgumentList '--test-cfg', 'toolbar=auto' | Out-Null
Start-Sleep -Milliseconds 500

# the capsule: the selection flows into a pill; the screen must be dimmed right away
Start-Process $exe -ArgumentList '--test-cfg', 'toolbar=capsule' | Out-Null
Start-Sleep -Milliseconds 800
Start-Process $exe -ArgumentList '--test-shot', 'area' | Out-Null
Start-Sleep -Milliseconds 2200
Shot "39a-dim-idle"
Start-Process $exe -ArgumentList '--test-sel', '300,200,640,380' | Out-Null
# frames while the selection flows into the capsule: nothing inside may appear piece by piece
$t0 = Get-Date
for ($k = 0; $k -lt 14; $k++) { Shot ("39f-{0:D2}" -f $k) }
Log "capsule burst: 14 frames in $([math]::Round(((Get-Date) - $t0).TotalMilliseconds)) ms"
Start-Sleep -Milliseconds 400
Shot "39-capsule"
[W]::SetCursorPos(5, 5) | Out-Null; Start-Sleep -Milliseconds 1200
Shot "39c-capsule-mouse-away"
Log "capsule with the mouse away: overlay visible $(Vis 'Retocker Snap — выделение')"
Cpu 'capsule up' 2
Log "capsule: card visible $(Vis 'Retocker Snap — снимок') (should be False)"
Log "capsule: clipboard has an image: $([System.Windows.Forms.Clipboard]::ContainsImage())"
[W]::keybd_event(0x1B, 0x01, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::keybd_event(0x1B, 0x01, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900
Log "capsule: overlay after Esc: $(Vis 'Retocker Snap — выделение')"

# the editor: the capsule thumbnail flows into it, nothing inside may appear piece by piece
Start-Process $exe -ArgumentList '--test-shot', 'area' | Out-Null
Start-Sleep -Milliseconds 2200
Start-Process $exe -ArgumentList '--test-sel', '300,200,640,380' | Out-Null
Start-Sleep -Milliseconds 1300
Shot "40-capsule-before-editor"
Start-Process $exe -ArgumentList '--test-ed', 'open' | Out-Null
$t0 = Get-Date
for ($k = 0; $k -lt 14; $k++) { Shot ("41e-{0:D2}" -f $k) }
Log "editor open burst: 14 frames in $([math]::Round(((Get-Date) - $t0).TotalMilliseconds)) ms"
Start-Sleep -Milliseconds 500
Shot "41-editor"
Start-Process $exe -ArgumentList '--test-ed', 'draw' | Out-Null
Start-Sleep -Milliseconds 3200
Shot "42-editor-draw"
Start-Process $exe -ArgumentList '--test-ed', 'crop' | Out-Null
Start-Sleep -Milliseconds 2200
Shot "43-editor-crop"
Start-Process $exe -ArgumentList '--test-ed', 'undo' | Out-Null
Start-Sleep -Milliseconds 1600
Shot "44-editor-undo"
Start-Process $exe -ArgumentList '--test-ed', 'redo' | Out-Null
Start-Sleep -Milliseconds 1600
Start-Process $exe -ArgumentList '--test-ed', 'close' | Out-Null
$t0 = Get-Date
for ($k = 0; $k -lt 12; $k++) { Shot ("45c-{0:D2}" -f $k) }
Log "editor close burst: 12 frames in $([math]::Round(((Get-Date) - $t0).TotalMilliseconds)) ms"
Start-Sleep -Milliseconds 500
Shot "46-capsule-after-editor"
$ci = [System.Windows.Forms.Clipboard]::GetImage()
if ($ci) { Log "editor: clipboard image $($ci.Width)x$($ci.Height)" } else { Log "editor: clipboard has no image" }
Log "editor: overlay visible $(Vis 'Retocker Snap — выделение')"
[W]::keybd_event(0x1B, 0x01, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::keybd_event(0x1B, 0x01, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900
Log "editor: overlay after Esc: $(Vis 'Retocker Snap — выделение')"
Start-Process $exe -ArgumentList '--test-cfg', 'capPos=bottom' | Out-Null
Start-Sleep -Milliseconds 600
Start-Process $exe -ArgumentList '--test-shot', 'full' | Out-Null
Start-Sleep -Milliseconds 2400
Shot "39b-capsule-full"
Log "capsule full: overlay visible $(Vis 'Retocker Snap — выделение')"
[W]::keybd_event(0x1B, 0x01, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::keybd_event(0x1B, 0x01, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900
Start-Process $exe -ArgumentList '--test-cfg', 'capPos=place' | Out-Null
Start-Sleep -Milliseconds 400
Start-Process $exe -ArgumentList '--test-cfg', 'toolbar=auto' | Out-Null
Start-Sleep -Milliseconds 500

# full screen straight away
Start-Process $exe -ArgumentList '--test-shot', 'full' | Out-Null
Start-Sleep -Milliseconds 3000
Shot "35-full"
[W]::keybd_event(0x1B, 0x01, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::keybd_event(0x1B, 0x01, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900
# Win+Shift+S must open Snap instead of the Windows tool
Key 0x5B $false; Key 0x10 $false; Start-Sleep -Milliseconds 40; Key 0x53 $false; Start-Sleep -Milliseconds 40; Key 0x53 $true; Key 0x10 $true; Key 0x5B $true
Start-Sleep -Milliseconds 2200
Shot "35w-winshifts"
Log "win+shift+s: overlay visible $(Vis 'Retocker Snap — выделение')"
Key 0x1B $false; Start-Sleep -Milliseconds 40; Key 0x1B $true
Start-Sleep -Milliseconds 900
Log "after all flows: overlay visible $(Vis 'Retocker Snap — выделение') (should be False)"
Cpu 'idle in tray'
Start-Process $exe -ArgumentList '--test-page', 'hist' | Out-Null
Start-Sleep -Milliseconds 2000
Shot "36-history"

$logf = Join-Path $env:LOCALAPPDATA "com.retocker.snap\logs\retocker-snap.log"
Log "---- app log"
if (Test-Path $logf) { Get-Content $logf | ForEach-Object { Log $_ } } else { Log "no log at $logf" }
if ($p.HasExited) { Log "APP EXITED, code $($p.ExitCode)"; exit 1 }
Stop-Process -Id $p.Id -Force
Start-Sleep 2

# the installer: a copy named «…Setup…» opens the installer window. Only look at it, do not install.
$tmp = Join-Path $env:TEMP 'snap-setup-test'
New-Item -ItemType Directory -Force $tmp | Out-Null
$setup = Join-Path $tmp 'Retocker-Snap-Setup.exe'
Copy-Item $exe $setup -Force
$sp = Start-Process $setup -PassThru
Start-Sleep 7
Shot "40-setup"
Log "installer visible: $(Vis 'Установка Retocker Snap')"
if (-not $sp.HasExited) { Stop-Process -Id $sp.Id -Force }
Log "ok"
