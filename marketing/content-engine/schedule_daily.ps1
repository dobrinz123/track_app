# Registers (or removes) a Windows scheduled task that runs the content engine once a day.
#   powershell -ExecutionPolicy Bypass -File schedule_daily.ps1            # daily at 09:00
#   powershell -ExecutionPolicy Bypass -File schedule_daily.ps1 -At 18:30
#   powershell -ExecutionPolicy Bypass -File schedule_daily.ps1 -Remove
param([string]$At = "09:00", [switch]$Remove)
$name = "TRACE content engine"
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "Removed '$name'."; return }
$python = (Get-Command python).Source
$action = New-ScheduledTaskAction -Execute $python -Argument "run.py daily" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
"Registered '$name' daily at $At. Clips land in the Studio under 'De revizuit'."
