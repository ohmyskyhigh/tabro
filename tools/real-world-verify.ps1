param([Parameter(Mandatory = $true)][string]$RunId)

Write-Error "The RunId verifier understands only the retired relay-v1 evidence format and cannot qualify Tabro 0.3.0. Follow doc\06-Files\Real-World-Runbook.md and verify the canonical fourteen-tool workflow instead. RunId was: $RunId"
exit 2
