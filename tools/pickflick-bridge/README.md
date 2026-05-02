# PickFlick Bridge

PickFlick Bridge is a local Windows helper that lets the GitHub Pages PickFlick app talk to LM Studio and Radarr without putting Radarr API keys or local network details into Firebase.

## Install On Windows

From this folder, run PowerShell:

```powershell
.\Install-PickFlickBridge.ps1
```

The installer:

- checks for Node.js 18 or newer
- stops an already-running PickFlick Bridge on the same port before updating files
- copies the bridge to `%LOCALAPPDATA%\PickFlickBridge\app`
- creates a desktop setup shortcut
- creates a startup shortcut so the bridge starts when Windows signs in
- opens `http://127.0.0.1:8765/setup`

The setup page walks through:

1. LM Studio IP/port
2. LM Studio connection test
3. loaded model dropdown
4. Radarr IP/port/API key
5. Radarr auth test
6. Radarr root folder and quality profile dropdowns

## Use In PickFlick

In PickFlick AI Mode, choose **Bridge** and use:

```text
http://127.0.0.1:8765
```

Keep the bridge running while the host is finding movies with AI or adding a non-library suggestion to Radarr.

If the setup page says `Restart needed`, rerun `.\Install-PickFlickBridge.ps1` from this folder. That means the browser loaded updated setup files while an older bridge process was still running.

## API

```text
GET  /health
GET  /lm/models
POST /lm/chat
GET  /radarr/status
GET  /radarr/defaults
POST /radarr/add
```

Setup-only endpoints:

```text
GET  /api/config
POST /api/lm/test
POST /api/lm/save
POST /api/radarr/test
POST /api/radarr/save
```

## Uninstall

```powershell
%LOCALAPPDATA%\PickFlickBridge\app\Uninstall-PickFlickBridge.ps1
```

Use `-KeepConfig` to remove the app and shortcuts but keep `config.json`.
