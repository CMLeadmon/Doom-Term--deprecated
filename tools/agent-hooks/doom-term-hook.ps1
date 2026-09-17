#Requires -Version 5.1
<#
Doom Term agent hook, for Windows.

The Windows sibling of doom-term-hook.sh, and it keeps that file's one rule:
NEVER STALL THE AGENT. The vendor runs this in the agent's critical path and
hands it the event payload on stdin. A hook that hangs is a paused agent, and
no telemetry is worth that.

  - reading stdin and the HTTP POST share a 1.8s deadline
  - input is bounded to 64 KiB; oversized events are dropped whole
  - all output discarded
  - exit 0 unconditionally, including when the daemon is not running

The POSIX version reaches that shape with GNU `timeout` wrapping `head` and
`curl`. Neither exists on a stock Windows, and Claude Code's native Windows
build no longer requires Git for Windows — so a .sh hook can only run on a
machine that happens to have one. This uses .NET directly instead of spawning
anything: a process launch is itself latency in a path measured against an
agent's responsiveness.

The agent name comes from the URL rather than being spliced into the JSON,
because rewriting arbitrary JSON is a bug farm and the payload must reach the
daemon exactly as the vendor wrote it.

Installed by tools/agent-hooks/install.mjs, which appends to the vendor's hook
config rather than replacing it — see that script for why.
#>
param([string]$Agent = 'unknown')

# Nothing below may surface an error to the agent. Every failure — no daemon,
# no network stack, a malformed environment — is a skipped event, not a fault.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Deliberately one budget, not one per step. The agent is waiting on the total.
$DeadlineMs = 1800
$MaxBytes = 65536

try {
    # Windows PowerShell 5.1 does not load System.Net.Http by default; pwsh 7
    # already has it and the second call is a no-op.
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue | Out-Null

    $port = if ($env:DOOM_PORT) { $env:DOOM_PORT } else { '1421' }
    $pane = $env:DOOM_TERM_SESSION_ID
    $incarnation = $env:DOOM_TERM_INCARNATION

    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter($DeadlineMs)

    # One byte past the cap, so an oversized event is DETECTABLE rather than
    # silently truncated. A half-event posted as if whole is worse than none:
    # the daemon would parse what it was given and believe it.
    $buffer = New-Object byte[] ($MaxBytes + 1)
    $stdin = [Console]::OpenStandardInput()
    $read = 0
    while ($read -lt $buffer.Length) {
        $task = $stdin.ReadAsync($buffer, $read, $buffer.Length - $read, $cts.Token)
        # Bounded twice: the token cancels the read, and Wait bounds us even if
        # the stream ignores cancellation — which a pipe held open by a process
        # that never writes will do.
        if (-not $task.Wait($DeadlineMs)) { exit 0 }
        $n = $task.Result
        if ($n -le 0) { break }
        $read += $n
    }
    if ($read -le 0 -or $read -gt $MaxBytes) { exit 0 }

    $handler = New-Object System.Net.Http.HttpClientHandler
    # A loopback event must never take an inherited proxy route. This is the
    # counterpart of `curl --disable --noproxy "*"`.
    $handler.UseProxy = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds($DeadlineMs)

    $content = New-Object System.Net.Http.ByteArrayContent($buffer, 0, $read)
    $content.Headers.ContentType =
        New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/json')

    # The pane id is inherited from the PTY, never spliced into vendor JSON.
    if ($pane) {
        $client.DefaultRequestHeaders.Add('X-Doom-Term-Session', $pane)
        if ($incarnation) {
            $client.DefaultRequestHeaders.Add('X-Doom-Term-Incarnation', $incarnation)
        }
    }

    $client.PostAsync("http://127.0.0.1:$port/hook/$Agent", $content, $cts.Token).Wait($DeadlineMs) | Out-Null
}
catch {
    # Swallowed on purpose. See the note on $ErrorActionPreference above.
}
finally {
    if ($client) { $client.Dispose() }
    if ($cts) { $cts.Dispose() }
}

exit 0
