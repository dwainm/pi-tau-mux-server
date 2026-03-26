# Pi Tau Mux Server

Standalone server that aggregates multiple [pi coding agent](https://github.com/mariozechner/pi-coding-agent) instances into one unified web UI.

## Architecture

```
┌─────────────┐                    ┌──────────────────────┐                    ┌─────────────┐
│  Pi TUI     │                    │  pi-tau-mux-server   │                    │  Browser    │
│  (terminal) │    WebSocket /pi    │  (standalone daemon) │    WebSocket /ws   │  (Tau UI)  │
│             │◄───────────────────►│                      │◄──────────────────►│             │
└─────────────┘                    │  Aggregates all      │                    └─────────────┘
                                   │  Pi instances        │
┌─────────────┐                    │                      │                    ┌─────────────┐
│  Pi TUI     │                    │  Serves web UI       │                    │  Phone      │
│  (another)  │◄───────────────────►│  Scans sessions      │◄──────────────────►│  (QR scan)  │
└─────────────┘                    └──────────────────────┘                    └─────────────┘
```

**This server** = standalone daemon (web UI, session browser, Tailscale support)  
**[pi-tau-mux](https://github.com/dwainm/pi-tau-mux)** = Pi extension (lightweight client that connects here)

## Features

- **Session Browser** — View all Pi sessions across projects with active/stale/ended status
- **Live Mirror** — Connect multiple Pi instances, stream messages in real-time
- **Tailscale Support** — Auto-detects Tailscale IP and MagicDNS for remote access
- **QR Codes** — Scan from phone/tablet to access remotely
- **Status Tracking** — Active (< 3 days), stale (< 30 days), ended detection
- **Clean Names** — Shows `basename-paneId` instead of encoded paths

## Install

```bash
npm install -g pi-tau-mux-server
```

Or run without installing:

```bash
npx pi-tau-mux-server
```

## Usage

Start the server:

```bash
pi-tau-mux-server
```

With custom port:

```bash
TAU_PORT=3001 pi-tau-mux-server
```

Open the URL shown in the output (e.g., `http://localhost:3001`).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TAU_PORT` | 3001 | Server port |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server health + Tailscale info |
| `/api/sessions` | GET | List all sessions grouped by project |
| `/api/sessions/:dir/:file` | GET | Load session file contents (JSONL) |
| `/api/sessions/switch` | POST | No-op (acknowledges session switch) |
| `/api/qr` | GET | QR code page for mobile access |

## WebSocket Endpoints

| Path | Description |
|------|-------------|
| `/ws` | Browser clients (web UI) |
| `/pi` | Pi client connections ([pi-tau-mux](https://github.com/dwainm/pi-tau-mux) extension) |

## Tailscale

If Tailscale is running, the server auto-detects it:

1. Scans network interfaces for `100.x.x.x` IPs
2. Falls back to `tailscale status --json` CLI if available (for MagicDNS hostname)
3. Uses Tailscale IP/hostname for QR codes

This lets you scan the QR code from any device on your tailnet — no port forwarding needed.

## Session Status

| Status | Description |
|--------|-------------|
| `active` | Modified within last 3 days |
| `stale` | Modified within last 30 days |
| `ended` | Has `session_end` marker or older than 30 days |

## How It Works

1. **Server starts** — HTTP server on configured port, WebSocket endpoints ready
2. **Pi instances connect** — The [pi-tau-mux](https://github.com/dwainm/pi-tau-mux) extension registers each Pi instance
3. **Events stream** — Messages, tool calls, thinking blocks forwarded in real-time
4. **Sessions scanned** — Server reads `~/.pi/agent/sessions` for all historical sessions
5. **Browser connects** — Web UI shows live sessions + session browser

## Related

- **[pi-tau-mux](https://github.com/dwainm/pi-tau-mux)** — The Pi extension (client) that connects to this server
- **[pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)** — The Pi coding agent
- **[Tau (original)](https://github.com/deflating/tau)** — Original implementation (single-instance server)

## Why the Split?

The original Tau ran an HTTP server inside each Pi process. This mux architecture:

- **One server** for all Pi instances — no port conflicts
- **One port** to expose via Tailscale — easy remote access
- **Session aggregation** — see all sessions from one UI
- **Lower overhead** — server runs once, not per Pi instance

## License

MIT