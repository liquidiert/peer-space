# <img src="public/favicon.svg" width="64"/> PeerSpace

PeerSpace is a real-time 2D spatial virtual office. Walk around as an avatar, meet people in private zones, talk over proximity video/audio, and design the office yourself with the built-in Admin Map Builder.

- [Tech stack](#tech-stack)
- [Quick start (Docker Compose)](#quick-start-docker-compose)
- [Local development without Docker](#local-development-without-docker)
- [Configuration](#configuration)
- [Audio and video](#audio-and-video)
- [Deployment](#deployment)
- [Sign-in with Google](#sign-in-with-google)

---

## Tech stack

| Layer | Technology |
| :--- | :--- |
| Frontend | Vue 3, Tailwind CSS, Lucide icons, HTML5 Canvas |
| Backend | Hono (`@hono/node-server`), Socket.IO (presence, chat, media endpoint discovery) |
| Audio/video | [iroh](https://iroh.computer) in the browser via WebAssembly (`crates/peer-media`), WebCodecs (Opus, H.264/VP8) |
| Persistence | SQLite (`workspace.sqlite` via `bun:sqlite` / `sql.js`) |
| Auth | OpenID Connect with Google (direct, no identity broker) |
| Tooling | Vite, esbuild, TypeScript, Vitest (runs on Bun or Node.js 18+) |

---

## Quick start (Docker Compose)

The compose setup runs everything you need:

| Service | Purpose | URL |
| :--- | :--- | :--- |
| `peerspace` | The app | http://localhost:3000 |
| `iroh-relay` | Relay for audio and video (see [Audio and video](#audio-and-video)) | internal, exposed through your proxy |

```bash
# 1. Set a session secret and Google sign-in credentials (see Sign-in with Google)
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
# Then set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ADMIN_EMAILS in .env

# 2. Build and start everything
docker compose up -d

# 3. Check the status
docker compose ps
docker compose logs -f peerspace
```

Open http://localhost:3000 and sign in with Google. Accounts listed in `ADMIN_EMAILS` are admins from their first sign-in.

> [!NOTE]
> `docker-compose.override.yml` publishes port 3000 on the host. `docker compose` loads it automatically for local use. Platforms such as Coolify ignore it and route traffic through their own proxy.

---

## Local development without Docker

Prerequisites: [Bun](https://bun.sh) ≥ 1.0 (or Node.js ≥ 18 with npm).

```bash
bun install

# Dev server with watch mode on http://localhost:3000
bun run dev

# Type check & tests
bun run lint
bun run test
```

Sign-in needs a Google OAuth client that allows `http://localhost:3000/auth/callback` (see [Sign-in with Google](#sign-in-with-google)). Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SESSION_SECRET` in `.env`.

---

## Configuration

All variables are documented in [`.env.example`](.env.example). The most important ones:

### PeerSpace

| Variable | Description | Default (compose) |
| :--- | :--- | :--- |
| `SESSION_SECRET` | Signs session tokens and encrypts the login-state cookie. **Set this.** If it's empty, a random secret is generated at boot and every restart logs everyone out. | – |
| `GOOGLE_CLIENT_ID` | OAuth client ID (Web application) from Google Cloud Console. Without it, sign-in returns 503. | – |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret for the same client. Without it, sign-in returns 503. | – |
| `ADMIN_EMAILS` | Comma or space separated emails that are always admins. They can't be removed in the app. | Empty |
| `PUBLIC_URL` | Public origin, e.g. `https://space.example.com`. Used for the redirect URI `<PUBLIC_URL>/auth/callback`. If unset, it's derived from `X-Forwarded-Proto` / `X-Forwarded-Host`. | Empty (derived) |
| `PORT` | HTTP port inside the container | `3000` |
| `DATA_DIR` | Where the SQLite database is stored | `/app/data` (volume `peerspace_data`) |
| `IROH_RELAYS` | Comma-separated `https://` URL(s) of the iroh relay as browsers see it, e.g. `https://relay.example.com`. Read at startup (restart after changing it) and served at `GET /api/media-config`. See [Audio and video](#audio-and-video). | Empty (n0's public relays) |
| `RELAY_ACCESS_TOKEN` | Shared secret that locks the iroh relay to signed-in users. Set the same value for `peerspace` and `iroh-relay` (compose does this). The app serves `/internal/relay-access` only when it is set. See [Self-hosted relay](#self-hosted-relay). | Empty (relay is open) |
| `VITE_IROH_RELAYS` | Build-time fallback for iroh relays, comma-separated `https://` URLs. Used when `IROH_RELAYS` is unset. Baked in at build time. | n0's public relays |

### Bundled iroh relay

| Variable | Description | Default |
| :--- | :--- | :--- |
| `IROH_RELAY_MEM_LIMIT` | Container memory cap for the `iroh-relay` service | `128m` |
| `IROH_RELAY_ACCESS_URL` | Where the relay checks each endpoint when `RELAY_ACCESS_TOKEN` is set. Must start with `http://` or `https://`. Quotes, backslashes, spaces, brackets, `|` and `&` are not allowed. | `http://peerspace:3000/internal/relay-access` |

---

## Audio and video

Proximity audio, camera and screen share run between peers over [iroh](https://iroh.computer), compiled to WebAssembly from [`crates/peer-media`](crates/peer-media). WebRTC is not used.

- Every browser starts an iroh endpoint and announces its endpoint id over Socket.IO (`media:announce`). The announce is signed with the endpoint's key over the socket id, and every client checks it, so nobody can claim someone else's endpoint. Peers then dial each other by id. There is no offer/answer or ICE exchange, and a reconnect is just another dial. The lower endpoint id dials.
- Browsers can't open UDP sockets, so all media goes through an iroh relay. The browser uses the relay from `IROH_RELAYS` (served by the server), then the build-time `VITE_IROH_RELAYS`, then n0's public relays. The public relays are fine for trying things out. For real use, run your own relay as described in [Self-hosted relay](#self-hosted-relay).
- **Audio**: 20 ms Opus frames (32 kb/s, DTX) sent as QUIC datagrams, so a lost packet never holds up the next one. Each peer has a small jitter buffer (60 to 240 ms). Voice only goes to people in earshot who aren't deafened, and a muted mic sends nothing. Browsers without a WebCodecs Opus encoder fall back to 16 kHz mu-law.
- **Video**: the camera (640×480, 15 fps) and the screen (up to 1080p, 8 fps, tuned for text) are each encoded once and fanned out to all viewers, not once per viewer. The camera only goes to people in range. Screen shares follow zones (see [Zones and proximity](#zones-and-proximity)). Each track has its own ordered QUIC stream with a 3-frame queue. When a viewer's link can't keep up, that viewer's frames are dropped until the next keyframe instead of piling up delay. Other viewers aren't affected. Codec preference: H.264 baseline, then VP8, then VP9.
- Audio and video need WebCodecs: current Chrome, Edge, Firefox and Safari.

### Self-hosted relay

The compose file includes an `iroh-relay` service. It is built from [`relay/Dockerfile`](relay/Dockerfile) (iroh-relay 1.3.0, which must match the iroh version in [`crates/peer-media/Cargo.lock`](crates/peer-media/Cargo.lock)) and published to `ghcr.io/liquidiert/peer-space-relay` by the existing workflow. It serves plain HTTP on port 3340, configured in [`relay/relay.toml`](relay/relay.toml) (open) or [`relay/relay-locked.toml.in`](relay/relay-locked.toml.in) (access-controlled, see below). Your reverse proxy terminates TLS. QUIC/UDP and metrics are off, so only one port is used.

1. **Coolify:** give the `iroh-relay` service its own domain (e.g. `relay.example.com`) on port 3340. The compose file has `SERVICE_FQDN_IROHRELAY_3340` for this.
2. **Dokploy:** add a domain for the `iroh-relay` service, port 3340, in the UI.
3. The proxy must serve that domain over HTTPS and allow WebSocket upgrades (Traefik does by default).
4. Set `IROH_RELAYS=https://relay.example.com` on `peerspace` and redeploy.
5. Check it: `https://relay.example.com/healthz` should return `{"status":"ok",...}`.

- Media stays end-to-end encrypted. The relay only forwards packets it can't read.
- Browsers can't make direct peer-to-peer connections (no UDP), so all media passes through the relay. Bandwidth is the main cost. Each sender→viewer stream is up to about 450 kbit/s for a camera and 1.2 Mbit/s for a screen share, in and out of the relay. For example, 8 people with cameras in one zone come to about 25 Mbit/s in and 25 Mbit/s out. CPU and RAM use is small.
- The relay is open by default: anyone who knows the URL can relay through it. To lock it, set one shared secret, `RELAY_ACCESS_TOKEN`, in the environment. Compose passes it to both `peerspace` and `iroh-relay`. Generate it with `openssl rand -hex 32`:

  ```env
  RELAY_ACCESS_TOKEN=<openssl rand -hex 32>
  ```

- With `RELAY_ACCESS_TOKEN` set, the relay admits only endpoints of users who are currently signed in to PeerSpace. When it is unset, the relay is open. Restart the stack after changing it.
- The check runs when a connection is made. A user who leaves keeps an open relay connection until it drops.

### Zones and proximity

- Entering a private zone takes effect after you have stayed in it for 1 second. Walking through doesn't connect you to the zone, and you stay connected to nearby people on the floor in the meantime. Leaving a zone takes effect immediately.
- Screen shares stay in their zone. A share from inside a zone goes only to people settled in that zone. A share on the open floor goes to everyone on the floor, at any distance.
- Click-to-walk routes avoid passing through private zones (including desk zones) when a reasonable detour exists.

### Rebuilding the wasm module

`src/wasm/` is generated, so don't edit it by hand. After changing `crates/peer-media`, rebuild it and commit the output:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128   # must match Cargo.toml
./scripts/build-wasm.sh                            # also needs clang; uses wasm-opt if installed
```

---

## Deployment

### Docker Compose (e.g. Coolify)

`docker-compose.yml` is ready for production. Put a TLS-terminating reverse proxy in front of `peerspace` and `iroh-relay` (see [Self-hosted relay](#self-hosted-relay)), then set at least:

```env
SESSION_SECRET=<openssl rand -hex 32>
PUBLIC_URL=https://space.example.com
IROH_RELAYS=https://relay.example.com
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
ADMIN_EMAILS=you@example.com
```

Add `https://space.example.com/auth/callback` as an authorized redirect URI on the Google client (see [Sign-in with Google](#sign-in-with-google)). The proxy must set `X-Forwarded-Proto` and `X-Forwarded-Host` if you leave `PUBLIC_URL` unset.

### Plain Docker

```bash
docker build -t peerspace .
docker run -d --name peerspace -p 3000:3000 \
  -v peerspace_data:/app/data -e DATA_DIR=/app/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e PUBLIC_URL="https://space.example.com" \
  -e GOOGLE_CLIENT_ID="<client id>" \
  -e GOOGLE_CLIENT_SECRET="<client secret>" \
  -e ADMIN_EMAILS="you@example.com" \
  peerspace
```

### Without Docker

```bash
bun run build   # Vite client build to dist/, esbuild server bundle to dist/server.js
bun dist/server.js
```

### Health check

```bash
curl http://localhost:3000/api/health
# {"status":"ok","activeUsers":0}
```

---

## Sign-in with Google

PeerSpace signs users in with Google OpenID Connect directly, from the app server. There is no identity broker and no separate login service to run. Any Google account can sign in. Users are identified by their verified Google email address.

### Create the Google OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com) and select or create a project.
2. Go to **APIs & Services** → **OAuth consent screen** and fill it in. Under **Scopes**, add `openid`, `email` and `profile`.
3. Go to **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID** and choose **Web application**.
4. Under **Authorized redirect URIs**, add `https://<your-domain>/auth/callback`. For local development, also add `http://localhost:3000/auth/callback`.
5. Copy the client ID and client secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The redirect URI must match the one PeerSpace builds, which is `<PUBLIC_URL>/auth/callback`. If `PUBLIC_URL` is unset, the origin comes from the `X-Forwarded-Proto` and `X-Forwarded-Host` headers of your proxy. Without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, sign-in returns 503.

### Admins

Admin rights (map editing and the admin tools) come from two places:

- **`ADMIN_EMAILS`** lists comma separated emails that are always admins. They can't be removed in the app, so use it for the people who must never be locked out.
- **In the app**, any admin can grant or revoke admin rights for other users. Use the **Admins** panel, or **Make admin** / **Remove admin** in the people list. Grants are stored in the database (`admins` table).

### Security notes

- Sign-in uses the authorization code flow with PKCE. The `state`, PKCE verifier and `nonce` are kept in an encrypted, HttpOnly login-state cookie, which is encrypted with `SESSION_SECRET`.
- The ID token is checked for issuer, audience, expiry, `nonce` and `email_verified` before a user is signed in.
- Any Google account can sign in, including accounts outside your organization. Access to individual spaces is still controlled by space membership.
- Set `SESSION_SECRET` in production. It signs session tokens and encrypts the login-state cookie.

### Migrating from Keycloak

If you are moving from the earlier Keycloak setup:

- The `keycloak` and `keycloak-db` containers and the `keycloak_db_data` volume are no longer used. After you have verified that sign-in works, remove the volume with `docker volume rm <name>`. Find the name with `docker volume ls | grep keycloak`.
- Members of the Keycloak `admin` group must be added to `ADMIN_EMAILS`, or granted admin in the app.
- Users are identified by email, so existing space memberships keep working as long as people sign in with the same Google email address they used in Keycloak.
- Remove the `KEYCLOAK_*` and `PEERSPACE_URL` variables from your `.env` and deployment settings.
