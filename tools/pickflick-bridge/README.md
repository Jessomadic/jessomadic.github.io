# PickFlick Bridge

PickFlick Bridge is a local Windows helper that lets the GitHub Pages PickFlick app talk to LM Studio and Radarr without putting Radarr API keys or local network details into Firebase.

## Install On Windows

From this folder, run PowerShell:

```powershell
.\Install-PickFlickBridge.ps1
```

Optional host controls:

```powershell
.\Install-PickFlickBridge.ps1 -BridgeHost 192.168.1.6 -ListenHost 0.0.0.0 -Port 8765
```

The installer:

- checks for Node.js 18 or newer
- stops an already-running PickFlick Bridge on the same port before updating files
- copies the bridge to `%LOCALAPPDATA%\PickFlickBridge\app`
- migrates existing `config.json` settings into `%LOCALAPPDATA%\PickFlickBridge\settings.db.json`
- saves the selected LM Studio model, Radarr root folder, and Radarr quality profile in that database
- writes settings with atomic replace + rolling backups so they survive reinstall and reboot
- sends LM Studio a 10-minute idle TTL on AI requests so JIT-loaded models stay loaded across multi-chunk library reads
- creates a desktop setup shortcut
- creates `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PickFlick Bridge.bat` so the bridge starts when Windows signs in
- serves a local copy of PickFlick at `http://<bridge-host>:8765/pickflick/` for phones that block GitHub Pages to local HTTP bridge calls
- opens `http://127.0.0.1:8765/setup`
- listens on all local addresses by default so the Windows host and phones on the LAN can both reach it

The setup page walks through:

1. Bridge host/IP and port shown to PickFlick
2. LM Studio IP/port
3. LM Studio connection test
4. loaded model dropdown
5. Radarr IP/port/API key
6. Radarr auth test
7. Radarr root folder and quality profile dropdowns
8. saved Radarr add-settings verification

## Use In PickFlick

In PickFlick AI Mode, choose **Bridge** and use the URL shown on the setup page. On the Windows host it will usually be:

```text
http://127.0.0.1:8765
```

On a phone or another device, use the Windows machine's LAN IP from setup, for example `http://192.168.1.6:8765`.

If the GitHub Pages site cannot connect from a phone, open the local bridge-hosted app on the phone instead:

```text
http://192.168.1.6:8765/pickflick/
```

Keep the bridge running while the host is finding movies with AI or adding a non-library suggestion to Radarr.

If the setup page says `Restart needed`, rerun `.\Install-PickFlickBridge.ps1` from this folder. That means the browser loaded updated setup files while an older bridge process was still running.

## Settings Storage

Bridge settings are stored locally at:

```text
%LOCALAPPDATA%\PickFlickBridge\settings.db.json
```

The older `%LOCALAPPDATA%\PickFlickBridge\config.json` file is only used as a migration fallback. The database file is never pushed to GitHub and can contain local IPs/API keys, the selected LM Studio model, the selected Radarr root folder, and the selected Radarr quality profile.

## API

```text
GET  /health
GET  /lm/models
POST /lm/chat
GET  /radarr/status
GET  /radarr/defaults
POST /radarr/validate
POST /radarr/add
```

Setup-only endpoints:

```text
GET  /api/config
POST /api/bridge/save
POST /api/lm/test
POST /api/lm/save
POST /api/radarr/test
POST /api/radarr/save
```

## Uninstall

```powershell
%LOCALAPPDATA%\PickFlickBridge\app\Uninstall-PickFlickBridge.ps1
```

Use `-KeepConfig` to remove the app and shortcuts but keep the local settings database.
