# CatRack Host Agent

CatRack Host Agent is a Node.js service that lets the CatRack web interface
monitor and manage Minecraft servers running on the same Windows host. It
discovers server folders, reports status and live statistics, and provides
authenticated WebSocket controls for starting and stopping servers, sending
console commands, and viewing player information.

## Requirements

- Windows
- Node.js (a current LTS release is recommended)
- Minecraft server folders alongside the `catrack-backend` folder

The agent scans the parent folder of this project for server directories. A
folder is recognized when it contains a usable top-level `.jar`, or when it is
a supported Forge/NeoForge installation with `run.bat` and the corresponding
libraries. Server versions, ports, and icons are read from the server files.

## Setup

1. Install the dependencies from this directory:

   ```powershell
   npm install
   ```

2. Create a `.env` file in the project directory and set a secret token:

   ```dotenv
   AGENT_TOKEN=replace-with-a-long-random-secret
   ```

   To generate a random token with Node.js:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Start the agent:

   ```powershell
   node server.js
   ```

The agent listens on port `8067`. Keep the process running while using the
dashboard. At startup, it prints the directory being scanned and the servers it
found.

## Connecting the dashboard

The HTTP health endpoint is:

```text
http://localhost:8067/status
```

The WebSocket endpoint is:

```text
ws://localhost:8067/ws?token=YOUR_AGENT_TOKEN
```

Use `wss://` when connecting through an HTTPS tunnel or reverse proxy. Configure
the dashboard with the reachable WebSocket URL and the same token as
`AGENT_TOKEN`.

The status endpoint does not require authentication. WebSocket connections
require the token. The agent can start or stop servers and send arbitrary
commands to their consoles, so keep the token private and expose the service
only through a network or tunnel you trust.

## WebSocket messages

Send JSON objects over the authenticated WebSocket connection.

| Message | Purpose |
| --- | --- |
| `{"type":"rescan"}` | Rescan the server folders and return the server list. |
| `{"type":"start","server":"<name>"}` | Start a server. |
| `{"type":"stop","server":"<name>"}` | Stop a server. |
| `{"type":"restart","server":"<name>"}` | Restart a server. |
| `{"type":"command","server":"<name>","text":"<command>"}` | Send a console command. |
| `{"type":"get_logs","server":"<name>"}` | Request the server's buffered console output. |
| `{"type":"set_ram","server":"<name>","ramMB":2048}` | Set a RAM override in megabytes. Send `null` to clear it. |
| `{"type":"set_port","server":"<name>","port":25565}` | Update the server port in `server.properties`; it takes effect on next start. |
| `{"type":"get_players","server":"<name>"}` | Get players in the server's `usercache.json`. |
| `{"type":"get_player","server":"<name>","uuid":"<uuid>"}` | Get saved data and statistics for a player UUID. |
| `{"type":"watch","server":"<name>"}` | Subscribe to graph history and enable TPS polling for that server. |
| `{"type":"unwatch"}` | Stop watching the current server. |

The agent sends `server_list` when a client connects and after server
configuration or status changes. It broadcasts `console`, `status_change`, and
`stats` messages to connected clients. A watching client receives `history`;
other responses include `log_history`, `known_players`, `player_detail`, or
`error`.

Live player names are obtained by pinging each running server. Player details
are read from the server's world data, statistics, and player lists when those
files are present. TPS/MSPT polling uses Minecraft's `tick query` command for
servers that support it (Minecraft 1.20.3 and newer) and runs only while at
least one connected dashboard client is watching that server.

## Server configuration

The dashboard's RAM override is stored in `.host-agent.json` inside the server
folder. When an override is set, the agent launches the Java server process
with explicit `-Xms` and `-Xmx` values. Clearing the override uses the server's
`start.bat`/`run.bat` when available, or a basic Java launch otherwise.

Changing the port edits `server.properties`; restart the Minecraft server for
the change to take effect.
