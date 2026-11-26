# Installs Clowdy on Windows from the latest GitHub release:
#
#   irm https://<site>/install.ps1 | iex
#
# It downloads Clowdy-Setup.exe, checks its SHA-512 against the release's latest.yml, and runs it. The installer puts
# Clowdy in %LOCALAPPDATA%\Programs, asks for no administrator, and downloads the package of this computer from the same
# release. The app updates itself from then on.
#
# Settings, all optional, as environment variables:
#   CLOWDY_VERSION      install this version (0.1.2) instead of the latest
#   CLOWDY_SILENT       set to anything to run the installer without its window
#   CLOWDY_REPO         the GitHub repository whose releases hold the app, reforma-ai/clowdy unless set
#   CLOWDY_RELEASE_URL  the folder that holds latest.yml and Clowdy-Setup.exe, in place of the release (for tests)
#
# Everything is in one function that runs on the last line: a download cut short never runs half of the script.

function Install-Clowdy {
    $ErrorActionPreference = 'Stop'

    if ($env:OS -ne 'Windows_NT') {
        throw 'This installer is for Windows. On macOS, run install.sh in a terminal.'
    }

    # Windows PowerShell 5.1 does not speak TLS 1.2 unless it is asked to.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = if ($env:CLOWDY_REPO) { $env:CLOWDY_REPO } else { 'reforma-ai/clowdy' }

    if ($env:CLOWDY_RELEASE_URL) {
        $base = $env:CLOWDY_RELEASE_URL.TrimEnd('/')
    } elseif ($env:CLOWDY_VERSION) {
        $base = "https://github.com/$repo/releases/download/v$($env:CLOWDY_VERSION.TrimStart('v'))"
    } else {
        $base = "https://github.com/$repo/releases/latest/download"
    }

    if (Get-Process -Name 'Clowdy' -ErrorAction SilentlyContinue) {
        throw 'Clowdy is running. Quit it and run the installer again.'
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('clowdy-' + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null

    try {
        Write-Host 'Looking for Clowdy'

        # A file is read from disk: GitHub serves it as a binary, and the text of the answer would be bytes.
        $feedFile = Join-Path $tmp 'latest.yml'

        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/latest.yml" -OutFile $feedFile
        } catch {
            throw "Could not read $base/latest.yml. Check the connection, and that the release exists and is public."
        }

        $feed = [IO.File]::ReadAllText($feedFile)

        # `- url: Clowdy-Setup.exe` with an indented `sha512: <base64>` under it.
        if ($feed -notmatch '(?m)^\s*-\s+url:\s+Clowdy-Setup\.exe\s+sha512:\s+(\S+)') {
            throw 'latest.yml has no download for Clowdy-Setup.exe.'
        }

        $expected = $Matches[1]
        $version = if ($feed -match '(?m)^version:\s*(\S+)') { $Matches[1] } else { '' }

        Write-Host "Downloading Clowdy $version"

        $setup = Join-Path $tmp 'Clowdy-Setup.exe'

        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/Clowdy-Setup.exe" -OutFile $setup
        } catch {
            throw "Could not download $base/Clowdy-Setup.exe."
        }

        $sha = [Security.Cryptography.SHA512]::Create()
        $stream = [IO.File]::OpenRead($setup)

        try {
            $actual = [Convert]::ToBase64String($sha.ComputeHash($stream))
        } finally {
            $stream.Dispose()
            $sha.Dispose()
        }

        if ($actual -ne $expected) {
            throw 'Clowdy-Setup.exe does not match the checksum in latest.yml, so it was not run.'
        }

        Write-Host 'Installing Clowdy'

        if ($env:CLOWDY_SILENT) {
            $process = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
        } else {
            $process = Start-Process -FilePath $setup -Wait -PassThru
        }

        if ($process.ExitCode -ne 0) {
            throw "The installer stopped with code $($process.ExitCode)."
        }

        Write-Host "Clowdy $version is installed"
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

Install-Clowdy
