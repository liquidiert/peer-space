# PeerSpace ![peer-space-logo.png](public\favicon-32x32.png)

Pixel Office World (PeerSpace) is a real-time 2D spatial virtual office and multiplayer workspace. Features interactive avatars, private meeting zones, proximity video/audio docks, and an interactive Admin Map Builder.

---

## 🛠️ Built With

- **Frontend**: Vue 3 + Tailwind CSS + Lucide Icons + HTML5 Canvas (with Browser Avatar & Name Persistence)
- **Backend & Persistence**: Hono (`@hono/node-server`) + Socket.IO + SQLite Database (`workspace.sqlite` via `bun:sqlite` / `sql.js`) + OpenID Connect (Keycloak / Google OIDC)
- **Bundler & Runtime**: Vite + Esbuild + TypeScript (compatible with Bun & Node.js 18+)

---

## 🚀 Quick Start & Local Development

### Prerequisites
- Node.js (v18+) or Bun (v1.0+)
- npm or bun package manager

### Installation & Development Run

```bash
# 1. Install dependencies
npm install

# 2. Start development server (Port 3000)
npm run dev
# or with bun:
bun server.ts
```

---

## 🐳 Docker & Production Deployment Guide

### 1. Environment Variables Configuration

Create a `.env` file or supply environment variables to your deployment environment:

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `PORT` | Container internal & exposed port | `3000` |
| `NODE_ENV` | Environment mode | `production` |
| `KEYCLOAK_URL` | Base URL of Keycloak Realm | `https://cloak.dev.personalclientcare.com/realms/ins3c` |
| `KEYCLOAK_CLIENT_ID` | Keycloak OIDC Client ID | `ins3c-login` |
| `KEYCLOAK_CLIENT_SECRET` | Keycloak Client Secret (if confidential) | `""` |

---

## 2. Standard Production Build (Node.js / Bun)

```bash
# 1. Compile Vite frontend assets into dist/ & bundle Hono server to dist/server.js
npm run build

# 2. Launch production server on port 3000
npm start
# or:
node dist/server.js
```

---

### 3. Deploying with Docker (Bun)

Build and run a lightweight production container using Bun (`oven/bun:1-alpine`):

```bash
# Build the Bun Docker image
docker build -t peerspace-app .

# Run the container mapping port 3000
docker run -d \
  --name peerspace \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e KEYCLOAK_URL="https://cloak.dev.personalclientcare.com/realms/ins3c" \
  -e KEYCLOAK_CLIENT_ID="ins3c-login" \
  peerspace-app
```

---

### 4. Deploying with Docker Compose

Use `docker-compose.yml` for simplified multi-container management, automatic restarts, and built-in health checks:

```bash
# Start container in detached mode
docker-compose up -d --build

# Inspect container status and health check
docker-compose ps

# View live container logs
docker-compose logs -f peerspace
```

---

### 5. Health Check & Monitoring

The production server includes a built-in health check endpoint:

```bash
curl http://localhost:3000/api/health
```

**Sample Response:**
```json
{
  "status": "ok",
  "activeUsers": 0
}
```

---

## 🔐 Keycloak Integration & Admin Group Setup Guide

### 1. Understanding UserInfo & Token Claims

When logging in via Keycloak OIDC, the standard `/userinfo` endpoint payload returns default user claims:

```json
{
  "sub": "",
  "email_verified": true,
  "name": "USERNAME",
  "groups": [
    "default-roles-peer-space",
    "offline_access",
    "uma_authorization"
  ],
  "preferred_username": "EMAIL",
  "given_name": "USER",
  "family_name": "NAME",
  "email": "EMAIL"
}
```

By default, Keycloak only populates default realm roles in `groups`. To grant **Admin Map Editing permissions** to a user, custom group claims or role mappers must be explicitly configured.

---

### 2. Configuring Custom Protocol Mappers for Admin Access

To ensure Keycloak includes custom user groups (e.g. `/admin` or `admin`) or client roles in the user payload:

1. Open the **Keycloak Admin Console**.
2. Navigate to **Clients** -> Select your application client (e.g. `peer-space`).
3. Click on the **Client scopes** tab -> Select the dedicated client scope (or click **Mappers** directly).
4. Click **Add mapper** -> **By configuration**:
   - **Mapper Type**: `Group Membership`
   - **Name**: `groups`
   - **Token Claim Name**: `groups`
   - **Add to ID token**: `ON`
   - **Add to access token**: `ON`
   - **Add to userinfo**: `ON`
   - **Full group path**: `ON` (e.g., outputs `/admin`)
5. Save the mapper configuration.

> **Note**: Pixel Office World automatically scans incoming OIDC `userinfo` / JWT payloads recursively for any `/admin` or `admin` string within `groups`, `roles`, `realm_access`, `resource_access`, or custom claims.

---

### 3. Authentication Flow Details (First Broker Login)

If you are using Identity Provider (IDP) Brokered Authentication (e.g., social logins, external OIDC brokers, Google Workspace), configure the **First Broker Login - No Auto User** flow in Keycloak under **Authentication**:

![Keycloak Authentication Flow Configuration](./assets/auth-flow.png)

#### Execution Steps & Requirements:

| Step | Execution Step Name | Requirement |
| :--- | :--- | :--- |
| 1 | **Review Profile** (`first broker login - No auto user review profile config`) | `Required` |
| 2 | **Detect existing broker user** | `Required` |
| 3 | **Automatically set existing user** | `Required` |
| 4 | **first broker login - No auto user User creation or linking** | `Alternative` |
| 5 | **Create User If Unique** (`first broker login - No auto user create unique user config`) | `Disabled` |
