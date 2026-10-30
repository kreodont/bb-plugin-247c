/** Explorer's process exit code does not report whether it selected a file.
 * Ask the Shell API instead and propagate its HRESULT through PowerShell.
 * Encode the path as data so quotes and PowerShell syntax never execute.
 */
export function windowsRevealArgs(file: string): string[] {
  const script = `$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FileLocation {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  public static void Show(IntPtr window) {
    ShowWindow(window, IsIconic(window) ? 9 : 5);
    SetForegroundWindow(window);
  }
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint mode);
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHParseDisplayName(string name, IntPtr context, out IntPtr pidl, uint attributes, out uint result);
  [DllImport("shell32.dll")]
  static extern int SHOpenFolderAndSelectItems(IntPtr pidl, uint count, IntPtr items, uint flags);
  public static void Reveal(string path) {
    Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero, 2));
    IntPtr pidl = IntPtr.Zero;
    try {
      uint attributes;
      Marshal.ThrowExceptionForHR(SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attributes));
      Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0));
    } finally {
      if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
      CoUninitialize();
    }
  }
}
'@
  $file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file, "utf8").toString("base64")}'))
  [FileLocation]::Reveal($file)
  # The hidden helper's startup state can also hide the Explorer window.
  # Only show a window that actually selected the requested file.
  $shell = New-Object -ComObject Shell.Application
  $visible = $false
  for ($attempt = 0; $attempt -lt 20 -and -not $visible; $attempt++) {
    foreach ($window in $shell.Windows()) {
      try {
        foreach ($item in $window.Document.SelectedItems()) {
          if ([String]::Equals($item.Path, $file, [StringComparison]::OrdinalIgnoreCase)) {
            $window.Visible = $true
            [FileLocation]::Show([IntPtr]$window.HWND)
            $visible = [FileLocation]::IsWindowVisible([IntPtr]$window.HWND)
            break
          }
        }
      } catch { continue }
      if ($visible) { break }
    }
    if (-not $visible) { Start-Sleep -Milliseconds 100 }
  }
  if (-not $visible) { throw 'Windows did not show a file manager window with the requested file selected.' }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
  return ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
