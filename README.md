# Pi Tau Mux Server

Standalone server that aggregates multiple [pi coding agent](https://github.com/mariozechner/pi-coding-agent) instances into one unified web UI.

## Features

- **Session Browser** - View all pi sessions across projects
- **Live Mirror** - Connect pi instances to stream messages in real-time
- **Tailscale Support** - Auto-detects Tailscale for easy remote access
- **QR Codes** - Quick mobile access via `/api/qr`
- **Status Tracking** - Active/stale/ended session detection

## Install

```bash
npm install -g pi-tau-mux-server
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

Open http://localhost:3001 in your browser.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TAU_PORT` | 3001 | Server port |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server health + Tailscale info |
| `/api/sessions` | GET | List all sessions grouped by project |
| `/api/sessions/:dir/:file` | GET | Load session file contents |
| `/api/qr` | GET | QR code for mobile access |

## WebSocket Endpoints

| Path | Description |
|------|-------------|
| `/ws` | Browser clients (web UI) |
| `/pi` | Pi client connections (extensions) |

## Tailscale

If Tailscale is installed and running, the server auto-detects it and:

1. Uses your Tailscale IP (100.x.x.x) for QR codes
2. Shows MagicDNS hostname if available
3. Includes Tailscale info in `/api/health`

This lets you scan the QR code from any device on your tailnet.

## Related

- [pi-tau-mux](https://github.com/dwainm/pi-tau-mux) - The pi extension (client)
- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) - The pi coding agent

## License

MIT