# TV Remote — Project State

A DIY phone-based remote for the Samsung Q6DAA 55" TV. Built for family use on the home WiFi. Free, local, no cloud.

## Quick reference

| Thing | Value |
|---|---|
| URL (any device on WiFi) | `http://gustavo-fring-pi.local:8080` |
| TV IP | `10.0.0.60` |
| TV WS endpoint | `wss://10.0.0.60:8002/api/v2/channels/samsung.remote.control` |
| Server port | `8080` (HTTP + WS on same port) |
| Auto-start | systemd unit (`/etc/systemd/system/tvremote.service`) |
| Host machine | Raspberry Pi `gustavo-fring-pi` (LAN `10.0.0.12`, Tailscale `100.123.186.21`). Always on. |

## Architecture

```
Phone PWA  ──ws──▶  Node server (Pi)        ──wss──▶  TV
(index.html)       (server.js, port 8080)            (10.0.0.60:8002)
                   /home/srikanthbanda/tv-remote
                   systemd unit: tvremote.service
```

The MacBook is now just the development machine; the Pi is the always-on production host. Edit on Mac, `scp` to Pi (or use rsync), `sudo systemctl restart tvremote` to reload.

The Node server is the only irreducible piece — browsers refuse the TV's self-signed TLS cert, and the non-TLS endpoint can't send keys. Verified empirically 2026-06-01: `ws://10.0.0.60:8001/api/v1/remote` pairs silently with no popup, but the TV rejects `ms.remote.control` on v1 with `"unrecognized method value"`. On this firmware (Q6DAA), key commands work **only** over v2-on-TLS (port 8002), so the Node proxy with `rejectUnauthorized: false` is the minimum viable bridge. See "Things ruled out" below for full probe results.

**TV WebSocket is a single persistent server-level connection** (not per-phone). All phones share one TV WS. Phone reconnects don't cycle the TV connection. On new phone connect, server immediately sends a synthetic `ms.channel.connect` if TV is already paired — dot goes green instantly.

## Files (in `TV_remote/`)

| File | Purpose |
|---|---|
| `server.js` | HTTP file server + persistent WS proxy to TV + device-info polling + WoL broadcaster + app-launch REST forwarder. The whole backend. |
| `index.html` | The PWA — swipe pad UI, smart state-aware power button, hold-repeat for Vol/Ch, Apps section, Settings, inline SVG icons, no external CDN. |
| `manifest.json` | PWA manifest. Makes phones treat it as an installable app. |
| `icon.svg` | App icon (home-screen + tab favicon). |
| `start.sh` | Manual run (dev): `node server.js`. Prints the URL. |
| `install-autostart.sh` | **Stale** — was for the macOS LaunchAgent path; superseded by the Pi systemd unit. |
| `test-ui.js` | Playwright smoke test. Stubs the WebSocket and asserts swipes/taps/hold-repeat/state-handling/WoL/app-launch produce the right outgoing messages. Run with `node test-ui.js`. |
| `.tv-token` | TV pairing token. Auto-saved/refreshed on every successful connect. Do not commit. |
| `.tv-mac` | TV wifiMac for Wake-on-LAN. Auto-cached from device-info polling. Do not commit. |
| `tvremote.log` | Service stdout/stderr (also via `journalctl -u tvremote -f`). |
| `package.json` + `node_modules/` | Just the `ws` library and `playwright` (dev). |

## UI (current — Apple-TV-remote-on-phone style)

- **Big swipe pad** dominates the screen. Quick swipe = single arrow key, tap = OK/Enter, **hold past threshold = continuous repeat** in the locked direction (400ms delay, 150ms cadence). Direction can be switched mid-hold by sliding to a different axis without lifting.
- **Below the pad:** Back · Home · Menu · Mute → Rewind · Play/Pause · Forward → Vol−/+ · Ch−/+.
- **Vol±/Ch± press-and-hold to repeat** (400ms delay, 100ms cadence). All other keys are single-fire.
- **Power button (top-right, red)** is state-aware: when TV is OFF it sends Wake-on-LAN and locks itself (shows "waking…", ignores further taps) until TV reports on or 60s elapses; when ON it sends KEY_POWER.
- **Status dot + label (top-left)** reflects combined state: green dot + `on` when TV is on, yellow dot + `off` when TV is in standby, red dot + `reconnecting…` only after being unreachable for 3+ seconds (brief phone reconnects are invisible).
- **"More" drawer** (slides up): number pad, color keys, Source · Guide · Info · Tools · Sleep · Ratio · CC · Exit, Apps (Netflix · YouTube · Prime · Disney+ · Apple TV · Spotify · Max · Hulu), Settings (Click sound toggle).
- **Press feedback** on every button: scale-down + brightness boost + small ripple from the touch point, plus a short Web Audio "tock" (default on, toggleable in More → Settings). Haptic is best-effort: `navigator.vibrate` on Android Chrome, and on iOS 17.4+ a hidden `<input type="checkbox" switch>` is toggled to elicit a system haptic — undocumented but commonly relied on.
- **iOS double-tap-zoom suppressed**: all interactive elements have `touch-action: manipulation`, and buttons fire on `pointerdown` rather than `click` so taps are instant.
- Auto-reconnects when the phone wakes from sleep.

## What works

- Power, Mute, Source
- Swipe pad → KEY_UP/DOWN/LEFT/RIGHT, tap → KEY_ENTER
- Back, Home, Menu
- Rewind, Play/Pause, Forward
- Vol +/−, Ch +/− (with press-and-hold repeat)
- Number pad, color keys, Guide, Info, Tools, Sleep, Ratio, CC, Exit
- Pairing token persistence (TV pop-up doesn't reappear on every reconnect)
- Auto-reconnect on visibility change (dot stays stable — no flicker)
- **Live TV power state** — server polls `http://10.0.0.60:8001/api/v2/` every 5s; header shows `on` / `off` within ~5s of change
- **Wake-on-LAN** — sends 3 rounds of magic packets (800ms apart) to both `255.255.255.255` and `10.0.0.255` on ports 7+9. Retry approach needed because TV's WiFi chip in power-save mode misses single packets. "Power On with Mobile" must be ON in TV network settings.
- **App launch via HTTP REST** — POST `/api/v2/applications/{appId}` (Netflix, YouTube, Prime, Disney+, Apple TV, Spotify, Max, Hulu). Replaced the dead `ed.apps.launch` WebSocket path.

## Known issues / limitations

- **Haptic on iOS Safari is unreliable.** `navigator.vibrate` is not supported on iOS at all (Android Chrome only). iOS 17.4+ does fire a system haptic when an `<input type="checkbox" switch>` is toggled — we exploit this via a hidden input — but the behaviour is undocumented and may break in a future iOS version. The Web Audio "tock" (default on) is the dependable felt feedback on iOS; visual ripple + scale work everywhere.
- **WoL requires that the TV's wifiMac was learned at least once while the TV was on.** Cached to `.tv-mac` on first successful poll. If the file is missing and the TV is currently off, WoL is a no-op — turn the TV on once with the physical remote.
- **App launchers via REST work, but the listing endpoint doesn't.** `GET /api/v2/applications/` returns 404 on this firmware, so the app IDs are hard-coded in `index.html`. Add new apps by editing the `data-app="..."` attributes.
- **No current-app detection.** Device-info exposes `PowerState` but not the foreground app, so the header shows `on` / `off` only. `ms.application.get` returns "unrecognized method value" on this firmware.
- **First-time pairing** still requires accepting a popup on the TV screen.

## How to run

**Already running** on the Pi via systemd — nothing to do unless you stopped it. Just open the URL on any device on the home WiFi.

Manage the service (SSH to the Pi first: `ssh srikanthbanda@gustavo-fring-pi.local` or `…@100.123.186.21`):
```
sudo systemctl status tvremote      # current state
sudo systemctl restart tvremote     # reload after code changes
sudo systemctl stop tvremote        # stop temporarily
sudo systemctl disable tvremote     # don't auto-start at boot
journalctl -u tvremote -f           # live logs (also written to ~/tv-remote/tvremote.log)
```

Deploy a code change from Mac:
```
cd "/Users/srikanthbanda/Documents/Fall 2023/Personal projects/AI hobbies/TV_remote"
scp server.js index.html manifest.json icon.svg srikanthbanda@gustavo-fring-pi.local:~/tv-remote/
ssh srikanthbanda@gustavo-fring-pi.local 'sudo systemctl restart tvremote'
```

## Key fixes baked in (don't accidentally undo these)

1. **Forward as TEXT frames, not binary.** Node's `ws` server receives browser messages as `Buffer`; must `.toString()` before forwarding or the TV silently ignores commands.
2. **Single persistent TV WebSocket.** One shared `tvWs` on the server; `tvReady` + `tvQueue` are server-level. On new phone connect, synthesize `ms.channel.connect` immediately if already paired. Do NOT revert to per-phone TV connections — it caused constant dot flickering.
3. **Save the token on every connect.** TV issues a fresh token each session; persist to `.tv-token` and load on next start.
4. **Decode Blob in the browser.** TV messages arrive as `Blob` — use `await e.data.text()` before `JSON.parse`.
5. **Token goes in the URL, not the name.** The pairing token must be a top-level query param (`?name=<b64>&token=<token>`), **not** stuffed inside the base64-encoded `name` JSON. If buried in `name`, the TV ignores it and pops up "Allow" on every reconnect. Fixed 2026-06-01.
6. **WoL retries.** Single UDP packet is unreliable over WiFi (TV NIC in power-save mode). Must send 3 rounds × 2 addresses × 2 ports. Do not simplify back to a single send.

## Adding to home screen (for family)

1. Open `http://gustavo-fring-pi.local:8080` in Safari/Chrome.
2. Share → "Add to Home Screen" → Add.
3. Tap the icon — opens full-screen, no browser chrome.

## Things ruled out (so we don't re-investigate)

| Idea | Verdict | Why |
|---|---|---|
| Trust the TV's self-signed cert on each family device | Won't work | Android Chrome ignores user-installed certs (system store only — needs root); iOS needs a profile install per device; the cert almost certainly has a hostname mismatch (CN ≠ `10.0.0.60`) so even "trusted" it'd still fail. |
| Use plain `ws://10.0.0.60:8001` to skip the proxy | Won't work for keys | TCP port is open. `/api/v1/remote` pairs silently and persists token — but rejects `ms.remote.control` (`"unrecognized method value"`). It's a presence/clients endpoint on this firmware, not a remote-control endpoint. |
| `GET /api/v2/applications/` to list installed apps | Returns 404 on this firmware | The endpoint exists per Samsung docs but isn't exposed by this TV. App IDs are hard-coded in `index.html` instead. |
| Use plain `ws://10.0.0.60:8002` (non-TLS on the TLS port) | Won't work | Immediately resets the connection. Port 8002 is TLS-only. |
| Browser flag to ignore TLS errors for wss | Not usable for family | Requires per-device, per-browser setup; not a "just open the URL" experience. |
| `ms.application.get` via WebSocket | Returns "unrecognized method value" | This firmware doesn't support it. Can't detect current app. |
| `ed.installedApp.get` via WebSocket | Returns "unrecognized method value" | Same — app listing not exposed on this firmware. |
| `GET /api/v2/tv/thumbnail` | Returns 404 | Thumbnail/screenshot API not exposed on this firmware. |
| Text input via `SendInputString` | Doesn't work for app keyboards | `SendInputString` only injects into Samsung's native IME. Apps that render their own keyboard UI (Prime Video, Netflix, etc.) ignore it entirely. |

## Parking lot (not started)

- Continuous-swipe / fling scrolling on the pad (multi-step navigation per swipe).
- Landscape layout.
- Lock-screen widget / Siri shortcut for power.
