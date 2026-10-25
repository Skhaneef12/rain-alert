# One-time setup of the instant-reply Worker. Safe to run again.
# Before the first run: npx --yes wrangler@4.145.0 login
# Usage (from the repository root): powershell -ExecutionPolicy Bypass -File .\worker\setup.ps1
# Add -GitHubRepo <owner>/<repo> to also save TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as that
# repository's GitHub secrets (needs the GitHub CLI, gh, logged in).
param([string]$GitHubRepo = '')
# Native tools (npx, gh) write warnings to stderr; only the web calls below are made strict.
Set-Location $PSScriptRoot
$wrangler = 'wrangler@4.145.0'

Write-Host ''
$secure = Read-Host 'Paste your bot token here and press Enter (input is hidden)' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
$api = "https://api.telegram.org/bot$token"

function Invoke-Telegram($method, $body) {
    try {
        $json = $body | ConvertTo-Json -Depth 6 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        return (Invoke-RestMethod -ErrorAction Stop -Method Post -Uri "$api/$method" -ContentType 'application/json; charset=utf-8' -Body $bytes).result
    } catch {
        # Do not print the exception: it can contain the request URL, which holds the token.
        Write-Host "Telegram $method failed. Check the token and run this again."
        exit 1
    }
}

# A webhook delivers messages to the Worker and blocks getUpdates, so disconnect it while we
# look for your message. Messages others send meanwhile wait and reach the Worker afterwards.
Invoke-Telegram 'deleteWebhook' @{ drop_pending_updates = $false } | Out-Null
$code = 'setup-' + (Get-Random -Minimum 1000 -Maximum 10000)
Write-Host ''
Write-Host "Now send this exact message to your bot in Telegram:  $code"
Write-Host '(The bot will not reply until this setup finishes.)'
$chatId = $null
$deadline = (Get-Date).AddMinutes(3)
while (-not $chatId -and (Get-Date) -lt $deadline) {
    $hit = @(Invoke-Telegram 'getUpdates' @{ timeout = 20 }) |
        Where-Object { $_.message.text -eq $code -and $_.message.chat.type -eq 'private' } | Select-Object -Last 1
    if ($hit) { $chatId = [string]$hit.message.chat.id; $who = $hit.message.chat.first_name }
}
if (-not $chatId) {
    Write-Host "Didn't receive $code within 3 minutes. Run this script again; until then the bot can't reply to commands."
    exit 1
}
Write-Host "Found your chat ($who)."

if ($GitHubRepo) {
    Write-Host "Saving TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in $GitHubRepo..."
    gh secret set TELEGRAM_BOT_TOKEN --repo $GitHubRepo --body $token
    if ($LASTEXITCODE -eq 0) { gh secret set TELEGRAM_CHAT_ID --repo $GitHubRepo --body $chatId }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Saving the GitHub secrets failed. Check that $GitHubRepo exists and gh is logged in, then run this again."
        exit 1
    }
}

Write-Host ''
Write-Host 'Deploying the Worker (Cloudflare may ask you to pick a workers.dev subdomain the first time)...'
npx --yes $wrangler deploy
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Deploy failed (see the message above). If it was the workers.dev question, run this again and answer y to "Ok to proceed?".'
    Write-Host 'If it says you are not logged in, run: npx --yes wrangler@4.145.0 login'
    exit 1
}

Write-Host 'Saving the secrets in Cloudflare...'
$secret = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
@{ BOT_TOKEN = $token; ADMIN_CHAT_IDS = $chatId; WEBHOOK_SECRET = $secret } | ConvertTo-Json -Compress |
    npx --yes $wrangler secret bulk | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'Saving the secrets failed.'; exit 1 }

# Deploy again quietly, now that no prompts are left, to read the Worker's address.
$out = npx --yes $wrangler deploy | Out-String
$url = [regex]::Match($out, 'https://[^\s]+\.workers\.dev').Value
if (-not $url) { Write-Host 'Could not find the Worker address in the deploy output.'; exit 1 }

Invoke-Telegram 'setWebhook' @{
    url = $url; secret_token = $secret; allowed_updates = @('message', 'callback_query')
} | Out-Null
$commands = @(
    @{ command = 'now'; description = 'Current rain outlook' },
    @{ command = 'off'; description = 'Stop rain warnings' },
    @{ command = 'on'; description = 'Turn rain warnings back on' },
    @{ command = 'status'; description = 'Are warnings on?' }
)
Invoke-Telegram 'setMyCommands' @{ commands = $commands } | Out-Null
Invoke-Telegram 'setMyCommands' @{
    commands = $commands + @(@{ command = 'users'; description = 'Who has access' })
    scope = @{ type = 'chat'; chat_id = [long]$chatId }
} | Out-Null

Write-Host ''
Write-Host "SETUP-DONE: Telegram now sends messages to $url"
Write-Host 'Try it: send /status to your bot. The reply should come within a few seconds.'
