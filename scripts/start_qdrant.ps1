# Start Qdrant via Docker Compose (project root).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
docker compose up -d
docker compose ps
