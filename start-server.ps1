Get-Process node -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 2
Start-Process node -ArgumentList 'test\serve.js' -WorkingDirectory 'C:\case-manager' -RedirectStandardOutput '.server-out.log' -RedirectStandardError '.server-err.log' -WindowStyle Hidden
Start-Sleep 12
Get-Content 'C:\case-manager\.server-out.log' -Tail 5
