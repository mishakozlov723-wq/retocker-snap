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
function Vis($t) { $h = [W]::FindWindow([NullString]::Value, $t); if ($h -eq [IntPtr]::Zero) { 'none' } else { [W]::IsWindowVisible($h) } }

$exe = (Resolve-Path "src-tauri/target/release/retocker-snap.exe").Path
Log "exe: $exe ($((Get-Item $exe).Length) bytes)"
$env:RA_DEBUG = '1'
$p = Start-Process $exe -PassThru
Start-Sleep 12
Shot "01-start"
Log "settings visible: $(Vis 'Retocker Snap')"

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

# full screen straight away
Start-Process $exe -ArgumentList '--test-shot', 'full' | Out-Null
Start-Sleep -Milliseconds 3000
Shot "35-full"
Start-Process $exe -ArgumentList '--test-page', 'hist' | Out-Null
Start-Sleep -Milliseconds 2000
Shot "36-history"

$logf = Join-Path $env:LOCALAPPDATA "com.retocker.snap\logs\retocker-snap.log"
Log "---- app log"
if (Test-Path $logf) { Get-Content $logf | ForEach-Object { Log $_ } } else { Log "no log at $logf" }
if ($p.HasExited) { Log "APP EXITED, code $($p.ExitCode)"; exit 1 }
Stop-Process -Id $p.Id -Force
Log "ok"
