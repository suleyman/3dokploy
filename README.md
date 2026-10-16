# 3Dokploy

**Your [Dokploy](https://dokploy.com) as a living, isometric server floor.** Projects become
buildings, environments become zones, services become racks and database tanks. Deploys roll in
on carts, network traffic flows in as packets, and a technician walks over to whatever goes down.

![3Dokploy showing demo data](docs/screenshot.jpg)

- **Live** – status, CPU, memory and network per service, deploys with their real build log,
  alerts for failed deploys and services in error, an activity feed.
- **Read-only** – 3Dokploy can't deploy, stop or change anything.
- **Private** – your Dokploy URL and API key stay in your browser, or on your own server.
- **Demo mode** – look around with made-up data, no Dokploy needed.

> Not affiliated with the Dokploy project.

## Using it

Open the app, enter your Dokploy URL and an API key, and connect.
Create a key in Dokploy under **Settings → Profile → API/CLI**.

Or press **Try the demo** (or open `/?mock`) to explore with generated data.

### Controls

| | |
| --- | --- |
| Click a building or its nameplate | Fly to the project, open its panel |
| Click a rack / tank | Select the service, open the inspector |
| `Esc` | Back out: service → project → overview |
| `Space` + drag, two-finger scroll, right/middle drag, arrow keys | Pan |
| Mouse wheel, pinch, `+` / `-` | Zoom (towards the cursor) |
| Left drag | Rotate |
| `F` / `Shift+F` / `R` | Frame the selection / fullscreen / reset the view |
| `/` | Filter nodes |
| `M` | Sound on/off |

## How it works

The UI is a static React + three.js app. A small **Node.js** server (Hono, no database) serves it
and runs a **relay** to Dokploy. The relay is needed because browsers can't call Dokploy directly:
its API sends no CORS headers, and an `http://` Dokploy can't be called from an `https://` page.

```
browser ──(per request: URL + key in headers)──▶ relay ──▶ your Dokploy
   └─ polling, diffing, metrics all happen here      └─ forwards and forgets
```

- A key you enter is saved only in **your browser's localStorage**. *Disconnect* deletes it.
- The relay is **stateless**: no database, no sessions, no logs of keys, URLs or responses.
- Only an **allowlist of read-only GET endpoints** is forwarded (`server/relay.ts`).
  Anything that changes state is refused, even with a key that could do it.
- **Secrets are stripped** from responses before they reach the browser: env vars, passwords,
  tokens, build secrets (3Dokploy never needs them).
- **SSRF protection** on open instances: private, loopback, link-local and metadata addresses are
  refused at connect time (after DNS, so rebinding doesn't help) and redirects are not followed.
- Same-origin only, with a strict Content-Security-Policy on the app.

A key you type into a hosted instance passes through whoever runs it. If you'd rather not trust
that, run your own: it's one container.

## Self-hosting

### Docker Compose

```sh
git clone https://github.com/suleyman/3dokploy.git && cd 3dokploy
cp .env.example .env    # optional, see below
docker compose up -d
```

Open <http://localhost:3000>. Dokploy itself listens on port 3000, so on the same machine set
`HOST_PORT=3100` (or any free port) in `.env`. Put it behind HTTPS if it's reachable from the internet.

A prebuilt image is published to `ghcr.io/suleyman/3dokploy` (see `.github/workflows/docker.yml`).

### Skip the connect screen

Pin the instance to your Dokploy with environment variables:

| Variables | Result |
| --- | --- |
| *(none)* | Open instance: everyone connects their own Dokploy; keys stay in their browsers. |
| `DOKPLOY_URL` | Only this Dokploy. The connect screen just asks for an API key. |
| `DOKPLOY_URL` + `DOKPLOY_API_KEY` | No connect screen at all. The key stays on the server and is never sent to browsers. |

Once `DOKPLOY_URL` is set, the relay talks to that Dokploy only (a private address such as
`http://host.docker.internal:3000` is fine). With `DOKPLOY_API_KEY` set, **anyone who can open the
site sees your Dokploy** (read-only, secrets stripped), so also set `BASIC_AUTH=user:password`.

### On Dokploy

**As a template:** `templates/dokploy/3dokploy/` holds a ready Dokploy template (compose file,
`template.toml`, metadata, logo). It points `DOKPLOY_URL` at the Dokploy on the same server,
turns on basic auth with a generated password, and leaves the API key empty: paste one into the
environment to skip the connect screen.

**From the repository:** create an application from this repository with the **Dockerfile**
build type and port **3000**, then add a domain.

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | Port for the app and the relay |
| `DOKPLOY_URL` | – | Pin the instance to one Dokploy |
| `DOKPLOY_API_KEY` | – | Keep the key on the server and skip the connect screen (needs `DOKPLOY_URL`) |
| `BASIC_AUTH` | – | `user:password` login for the whole site (recommended with `DOKPLOY_API_KEY`) |
| `ALLOW_PRIVATE_TARGETS` | off | Let an open instance reach private/LAN addresses. Only for non-public setups. |
| `RATE_LIMIT_PER_MIN` | `1200` | Relay requests per minute per client IP |

## Development

Requires Node.js 22.6 or newer (the server is plain TypeScript run directly by Node).

```sh
npm install
npm run dev        # Vite on :5173 (open this) + relay on :3000 behind it
npm run build      # typecheck + production build into dist/
npm start          # serve dist/ and the relay on :3000
```

### Layout

```
server/              relay (read-only Dokploy proxy) + static file server
src/data/dokploy/    Dokploy API client and the collector that polls and diffs (runs in the browser)
src/data/            types, data sources (Dokploy, demo), demo seed + simulation
src/layout.ts        projects → buildings, services → racks, walking routes
src/scene/           three.js scene (react-three-fiber): buildings, racks, agents, effects
src/hud/             overlay UI: top bar, menus, KPIs, inspector, pipeline, connect screen
src/sound.ts         UI sounds, synthesised with Web Audio
templates/dokploy/   Dokploy template
```

### Releasing

Pushing a tag like `v0.1.0` publishes `ghcr.io/suleyman/3dokploy:0.1.0` (amd64 + arm64).
Make the package public in GitHub's package settings so others can pull it.

## Notes and limits

- Metrics come from `docker stats` on the Dokploy host (Dokploy's monitoring service isn't
  required). Services on remote Dokploy servers show status and deploys, but no metrics yet.
- `docker stats` rounds network counters, so traffic rates are estimates over a short window.
- Polling pauses while the tab is in the background.

## License

[MIT](LICENSE)
