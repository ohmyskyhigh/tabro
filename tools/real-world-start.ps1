param([Parameter(Mandatory = $true)][string]$RunId)

Write-Error "The RunId scenario harness uses the retired relay-v1 MCP contract and cannot qualify Tabro 0.3.0. Follow doc\06-Files\Real-World-Runbook.md and use the canonical fourteen-tool workflow instead. RunId was: $RunId"
exit 2
