import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server, Socket } from 'socket.io';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createServer as createViteServer } from 'vite';
import { User, GridMap, ChatMessage, MapObject, WhiteboardStroke, StickyNote, PrivateZone } from './src/types';
import { createDefaultOfficeMap, createBeachRetreatMap } from './src/mapsData';
import { initWorkspaceDatabase } from './src/db';
import { createSessionToken, verifySessionToken } from './src/lib/session';

async function startServer() {
  const app = new Hono();
  const PORT = 3000;

  // Initialize SQLite persistence driver
  const db = await initWorkspaceDatabase();

  // In-memory application state
  const users: Map<string, User> = new Map(); // socket.id -> User

  // Available maps (Loaded from SQLite database or initialized with defaults)
  const maps: Map<string, GridMap> = new Map();
  const defaultOffice = createDefaultOfficeMap();
  const beachRetreat = createBeachRetreatMap();

  const savedMaps = db.loadMaps();
  if (savedMaps.length > 0) {
    savedMaps.forEach((m) => maps.set(m.id, m));
  } else {
    maps.set(defaultOffice.id, defaultOffice);
    maps.set(beachRetreat.id, beachRetreat);
    db.saveMap(defaultOffice);
    db.saveMap(beachRetreat);
  }

  let currentMapId = db.loadActiveMapId() || defaultOffice.id;
  if (!maps.has(currentMapId)) {
    currentMapId = defaultOffice.id;
  }
  db.saveActiveMapId(currentMapId);

  // Persistence helper
  function persistCurrentMap() {
    const map = maps.get(currentMapId);
    if (map) {
      db.saveMap(map);
    }
  }

  let vite: any;
  if (process.env.NODE_ENV !== 'production') {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
  }

  const listener = getRequestListener(app.fetch);

  const requestHandler = (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    const url = req.url || '';
    if (url.startsWith('/api/') || url.startsWith('/auth/')) {
      listener(req, res);
    } else if (vite) {
      vite.middlewares(req, res, () => {
        listener(req, res);
      });
    } else {
      listener(req, res);
    }
  };

  // In local dev, serve HTTPS if mkcert-generated certs are present (certs/dev-cert.pem, certs/dev-key.pem).
  // Mobile browsers only expose getUserMedia (mic/camera) on secure contexts, and a LAN IP over
  // plain http:// doesn't qualify - so testing WebRTC features from a phone needs this.
  const devCertPath = path.resolve(__dirname, 'certs/dev-cert.pem');
  const devKeyPath = path.resolve(__dirname, 'certs/dev-key.pem');
  const useHttps = process.env.NODE_ENV !== 'production' && fs.existsSync(devCertPath) && fs.existsSync(devKeyPath);

  const httpServer = useHttps
    ? createHttpsServer(
        { cert: fs.readFileSync(devCertPath), key: fs.readFileSync(devKeyPath) },
        requestHandler
      )
    : createServer(requestHandler);

  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Helper: Find private zone for coordinates
  function getPrivateZoneId(map: GridMap, x: number, y: number): string | null {
    // 1. Explicit private zones
    for (const zone of map.privateZones) {
      if (
        x >= zone.x &&
        x < zone.x + zone.width &&
        y >= zone.y &&
        y < zone.y + zone.height
      ) {
        return zone.id;
      }
    }
    // 2. Automatic private zone for 2x1 desks (lower 2x1 standing area y = desk.y + height, and desk tile itself)
    for (const obj of map.objects) {
      if (obj.type === 'desk') {
        const deskW = obj.width || 2;
        const deskH = obj.height || 1;
        if (
          x >= obj.x &&
          x < obj.x + deskW &&
          (y === obj.y || y === obj.y + deskH)
        ) {
          return `desk_zone_${obj.id}`;
        }
      }
    }
    return null;
  }

  // Calculate proximity and emit peer connections list to all users
  function updateSpatialProximity() {
    const map = maps.get(currentMapId);
    if (!map) return;

    const userList = Array.from(users.values());
    const PROXIMITY_TILE_RADIUS = 7; // Maximum tile distance for proximity voice

    userList.forEach((userA) => {
      const activePeers: { peerId: string; distance: number; inSameZone: boolean }[] = [];

      userList.forEach((userB) => {
        if (userA.socketId === userB.socketId) return;

        const zoneA = userA.currentZoneId;
        const zoneB = userB.currentZoneId;

        // Private zone logic:
        // If either user is in a private zone, they can ONLY connect if they are in the SAME private zone.
        if (zoneA || zoneB) {
          if (zoneA && zoneB && zoneA === zoneB) {
            // Both in same private zone -> Always connected regardless of grid distance!
            activePeers.push({ peerId: userB.socketId, distance: 0, inSameZone: true });
          }
          // If in different zones or one is outside -> no voice connection
          return;
        }

        // Neither is in a private zone -> Use Euclidean grid tile proximity
        const dist = Math.hypot(userA.position.x - userB.position.x, userA.position.y - userB.position.y);
        if (dist <= PROXIMITY_TILE_RADIUS) {
          activePeers.push({ peerId: userB.socketId, distance: dist, inSameZone: false });
        }
      });

      io.to(userA.socketId).emit('spatial:proximity_update', {
        activePeers,
      });
    });
  }

  // Socket.IO event handlers
  io.on('connection', (socket: Socket) => {
    console.log(`User connected: ${socket.id}`);

    // Join room
    socket.on('user:join', (payload: { name: string; avatar: any; isAdmin?: boolean; clientId?: string; email?: string; sessionToken?: string }) => {
      const map = maps.get(currentMapId) || defaultOffice;
      const initialZone = getPrivateZoneId(map, map.spawnPoint.x, map.spawnPoint.y);

      // isAdmin and a cross-device stable identity (email) can ONLY come from a verified
      // Keycloak session token - payload.isAdmin/email are otherwise fully client-controlled
      // and must never be trusted directly (that was previously a trivial privilege-escalation
      // hole: any client could just send { isAdmin: true }).
      const session = verifySessionToken(payload.sessionToken);
      const isAdmin = session ? session.isAdmin : false;
      const email = session ? session.email : undefined;
      const displayName = session?.name || payload.name || `Guest_${socket.id.substring(0, 4)}`;

      // Prefer a stable identity that survives reloads/reconnects (socket.id is re-generated
      // every connection) - the verified email when authenticated, else the persisted
      // per-browser clientId, else fall back to socket.id for older/guest clients.
      const stableId = email || payload.clientId || socket.id;

      const newUser: User = {
        id: stableId,
        socketId: socket.id,
        name: displayName,
        position: { ...map.spawnPoint },
        direction: 'down',
        avatar: payload.avatar || {
          skinColor: '#f87171',
          hairStyle: 'short',
          hairColor: '#1e293b',
          outfitColor: '#3b82f6',
          glasses: false,
          hatStyle: 'none',
          statusEmoji: '👋',
        },
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        isScreenSharing: false,
        isAdmin,
        currentZoneId: initialZone,
        lastSeen: Date.now(),
      };

      users.set(socket.id, newUser);

      // Send initial map & user state to connected user
      socket.emit('init:state', {
        currentUser: newUser,
        currentMap: map,
        users: Array.from(users.values()),
      });

      // Notify others
      socket.broadcast.emit('user:joined', newUser);

      updateSpatialProximity();
    });

    // Handle User Movement
    socket.on('user:move', (data: { x: number; y: number; direction: 'up' | 'down' | 'left' | 'right' }) => {
      const user = users.get(socket.id);
      if (!user) return;

      const map = maps.get(currentMapId);
      if (!map) return;

      // Validate bounds
      if (data.x < 0 || data.x >= map.width || data.y < 0 || data.y >= map.height) {
        return;
      }

      // Check collision with tile or blocking map objects
      const targetTile = map.tiles[data.y]?.[data.x];
      if (targetTile === 'wall_brick' || targetTile === 'wall_wood' || targetTile === 'water') {
        return; // blocked
      }

      const blockingObj = map.objects.find((obj) => {
        if (!obj.isBlocking) return false;
        return (
          data.x >= obj.x &&
          data.x < obj.x + obj.width &&
          data.y >= obj.y &&
          data.y < obj.y + obj.height
        );
      });

      if (blockingObj) {
        return; // blocked
      }

      // Update position & zone
      user.position = { x: data.x, y: data.y };
      user.direction = data.direction;
      user.currentZoneId = getPrivateZoneId(map, data.x, data.y);
      user.lastSeen = Date.now();

      // Broadcast move to all users
      io.emit('user:moved', {
        userId: socket.id,
        position: user.position,
        direction: user.direction,
        currentZoneId: user.currentZoneId,
      });

      updateSpatialProximity();
    });

    // Handle User Profile / Status Update
    socket.on('user:update_profile', (updates: Partial<User>) => {
      const user = users.get(socket.id);
      if (!user) return;

      if (updates.name) user.name = updates.name;
      if (updates.avatar) user.avatar = { ...user.avatar, ...updates.avatar };
      if (typeof updates.isMuted === 'boolean') user.isMuted = updates.isMuted;
      if (typeof updates.isDeafened === 'boolean') user.isDeafened = updates.isDeafened;
      if (typeof updates.isSpeaking === 'boolean') user.isSpeaking = updates.isSpeaking;
      if (typeof updates.isVideoOn === 'boolean') user.isVideoOn = updates.isVideoOn;
      if (typeof updates.isAdmin === 'boolean' && user.isAdmin) user.isAdmin = updates.isAdmin;

      io.emit('user:updated', user);
    });

    // Handle WebRTC Signaling
    socket.on('webrtc:signal', (data: { to: string; signal: any }) => {
      io.to(data.to).emit('webrtc:signal', {
        from: socket.id,
        signal: data.signal,
      });
    });

    // Handle Spatial / Room Chat
    socket.on('chat:send', (payload: { text: string; isSpatial: boolean }) => {
      const user = users.get(socket.id);
      if (!user) return;

      const chatMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        senderId: socket.id,
        senderName: user.name,
        text: payload.text,
        timestamp: Date.now(),
        isSpatial: payload.isSpatial,
        senderPosition: { ...user.position },
      };

      if (payload.isSpatial) {
        // Send to users within 8 tiles
        const PROXIMITY_CHAT_RADIUS = 8;
        users.forEach((otherUser) => {
          const dist = Math.hypot(
            user.position.x - otherUser.position.x,
            user.position.y - otherUser.position.y
          );
          if (dist <= PROXIMITY_CHAT_RADIUS || user.socketId === otherUser.socketId) {
            io.to(otherUser.socketId).emit('chat:message', chatMsg);
          }
        });
      } else {
        // Broadcast global room message
        io.emit('chat:message', chatMsg);
      }
    });

    // Interactive Object: Whiteboard stroke
    socket.on('object:whiteboard_stroke', (payload: { objectId: string; stroke: WhiteboardStroke }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj && obj.type === 'whiteboard') {
        if (!obj.data) obj.data = {};
        if (!obj.data.whiteboardStrokes) obj.data.whiteboardStrokes = [];
        obj.data.whiteboardStrokes.push(payload.stroke);

        io.emit('object:whiteboard_updated', {
          objectId: payload.objectId,
          strokes: obj.data.whiteboardStrokes,
        });

        persistCurrentMap();
      }
    });

    // Clear Whiteboard
    socket.on('object:whiteboard_clear', (payload: { objectId: string }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj && obj.type === 'whiteboard') {
        if (obj.data) obj.data.whiteboardStrokes = [];
        io.emit('object:whiteboard_updated', {
          objectId: payload.objectId,
          strokes: [],
        });

        persistCurrentMap();
      }
    });

    // Sticky Note Add
    socket.on('object:add_note', (payload: { objectId: string; note: StickyNote }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj && obj.type === 'sticky_notes') {
        if (!obj.data) obj.data = {};
        if (!obj.data.notes) obj.data.notes = [];
        obj.data.notes.push(payload.note);

        io.emit('object:notes_updated', {
          objectId: payload.objectId,
          notes: obj.data.notes,
        });

        persistCurrentMap();
      }
    });

    // Game move
    socket.on('object:game_move', (payload: { objectId: string; index: number; symbol: 'X' | 'O' }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj && obj.type === 'game_table' && obj.data?.gameState) {
        const state = obj.data.gameState;
        if (state.board[payload.index] === null && !state.winner) {
          state.board[payload.index] = payload.symbol;
          state.turn = payload.symbol === 'X' ? 'O' : 'X';

          // Check winning lines
          const lines = [
            [0, 1, 2], [3, 4, 5], [6, 7, 8],
            [0, 3, 6], [1, 4, 7], [2, 5, 8],
            [0, 4, 8], [2, 4, 6]
          ];

          for (const line of lines) {
            const [a, b, c] = line;
            if (state.board[a] && state.board[a] === state.board[b] && state.board[a] === state.board[c]) {
              state.winner = state.board[a];
              break;
            }
          }

          if (!state.winner && state.board.every((cell) => cell !== null)) {
            state.winner = 'Draw';
          }

          io.emit('object:game_updated', {
            objectId: payload.objectId,
            gameState: state,
          });

          persistCurrentMap();
        }
      }
    });

    // Reset Game
    socket.on('object:game_reset', (payload: { objectId: string }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj && obj.type === 'game_table' && obj.data?.gameState) {
        obj.data.gameState = {
          board: Array(9).fill(null),
          turn: 'X',
          winner: null,
          players: {},
        };
        io.emit('object:game_updated', {
          objectId: payload.objectId,
          gameState: obj.data.gameState,
        });

        persistCurrentMap();
      }
    });

    // Desk State Updates
    socket.on('object:desk_updated', (payload: { objectId: string; deskState: any }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj && (obj.type === 'desk' || obj.type === 'computer')) {
        obj.data = obj.data || {};
        obj.data.deskState = payload.deskState;
        if (payload.deskState?.claimedByUserName) {
          obj.name = `${payload.deskState.claimedByUserName}'s Desk`;
        }
        io.emit('map:object_updated', {
          objectId: payload.objectId,
          object: obj,
        });

        persistCurrentMap();
      }
    });

    // Map Builder - Add or Update Private Zone
    socket.on('map:add_zone', (zone: PrivateZone) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      const existingIndex = map.privateZones.findIndex((z) => z.id === zone.id);
      if (existingIndex >= 0) {
        map.privateZones[existingIndex] = zone;
      } else {
        map.privateZones.push(zone);
      }

      // Recalculate zone for all users
      users.forEach((u) => {
        u.currentZoneId = getPrivateZoneId(map, u.position.x, u.position.y);
      });

      io.emit('map:zones_updated', {
        privateZones: map.privateZones,
        users: Array.from(users.values()),
      });

      updateSpatialProximity();
      persistCurrentMap();
    });

    // Map Builder - Remove Private Zone
    socket.on('map:remove_zone', (zoneId: string) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      map.privateZones = map.privateZones.filter((z) => z.id !== zoneId);

      // Recalculate zone for all users
      users.forEach((u) => {
        u.currentZoneId = getPrivateZoneId(map, u.position.x, u.position.y);
      });

      io.emit('map:zones_updated', {
        privateZones: map.privateZones,
        users: Array.from(users.values()),
      });

      updateSpatialProximity();
      persistCurrentMap();
    });

    // Map Builder - Add or Place Object
    socket.on('map:place_object', (newObj: MapObject) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      map.objects.push(newObj);
      io.emit('map:object_placed', newObj);
      persistCurrentMap();
    });

    // Map Builder - Remove Object
    socket.on('map:remove_object', (objectId: string) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      map.objects = map.objects.filter((o) => o.id !== objectId);
      io.emit('map:object_removed', objectId);
      persistCurrentMap();
    });

    // Map Builder - Change Tile
    socket.on('map:change_tile', (payload: { x: number; y: number; tileType: any }) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      if (payload.y >= 0 && payload.y < map.height && payload.x >= 0 && payload.x < map.width) {
        map.tiles[payload.y][payload.x] = payload.tileType;
        io.emit('map:tile_changed', payload);
        persistCurrentMap();
      }
    });

    // Switch Map Preset
    socket.on('map:switch_preset', (mapId: string) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      if (maps.has(mapId)) {
        currentMapId = mapId;
        const newMap = maps.get(mapId)!;
        db.saveActiveMapId(currentMapId);

        // Teleport all current users to spawn
        users.forEach((u) => {
          u.position = { ...newMap.spawnPoint };
          u.currentZoneId = getPrivateZoneId(newMap, u.position.x, u.position.y);
        });

        io.emit('map:switched', {
          currentMap: newMap,
          users: Array.from(users.values()),
        });

        updateSpatialProximity();
      }
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.id}`);
      users.delete(socket.id);
      io.emit('user:left', socket.id);
      updateSpatialProximity();
    });
  });

  // REST API Endpoints with Hono
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', activeUsers: users.size });
  });

  app.get('/api/workspace/sqlite-info', (c) => {
    return c.json({
      status: 'ok',
      sqlite: db.getDbInfo(),
      activeMapId: currentMapId,
    });
  });

  // Keycloak / Google Auth Login URL Endpoint
  app.get('/api/auth/login-url', (c) => {
    const keycloakUrl = process.env.KEYCLOAK_URL || 'https://cloak.dev.personalclientcare.com/realms/ins3c';
    const clientId = process.env.KEYCLOAK_CLIENT_ID || 'ins3c-login';

    const reqUrl = new URL(c.req.url);
    const rawProto = c.req.header('x-forwarded-proto') || reqUrl.protocol.replace(':', '') || 'https';
    const proto = rawProto.split(',')[0].trim();
    const rawHost = c.req.header('x-forwarded-host') || c.req.header('host') || reqUrl.host || '';
    const host = rawHost.split(',')[0].trim();
    const finalProto = (host.endsWith('.run.app') || proto === 'https') ? 'https' : proto;
    const computedRedirectUri = `${finalProto}://${host}/auth/callback`;

    const redirectUri = c.req.query('redirect_uri') || computedRedirectUri;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
    });

    if (c.req.query('idp') === 'google') {
      params.append('kc_idp_hint', 'google');
    }

    const authUrl = `${keycloakUrl}/protocol/openid-connect/auth?${params.toString()}`;
    return c.json({ url: authUrl, redirectUri });
  });

  // OAuth Callback Endpoint
  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    const keycloakUrl = process.env.KEYCLOAK_URL || 'https://cloak.dev.personalclientcare.com/realms/ins3c';
    const clientId = process.env.KEYCLOAK_CLIENT_ID || 'ins3c-login';
    const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET || '';

    if (!code) {
      return c.text('Missing authorization code', 400);
    }

    try {
      const reqUrl = new URL(c.req.url);
      const rawProto = c.req.header('x-forwarded-proto') || reqUrl.protocol.replace(':', '') || 'https';
      const proto = rawProto.split(',')[0].trim();
      const rawHost = c.req.header('x-forwarded-host') || c.req.header('host') || reqUrl.host || '';
      const host = rawHost.split(',')[0].trim();
      const finalProto = (host.endsWith('.run.app') || proto === 'https') ? 'https' : proto;
      const redirectUri = `${finalProto}://${host}/auth/callback`;

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: code as string,
        redirect_uri: redirectUri,
      });

      if (clientSecret) {
        tokenBody.append('client_secret', clientSecret);
      }

      const tokenRes = await fetch(`${keycloakUrl}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      });

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        console.error('Keycloak token exchange error:', tokenRes.status, errorText);
        return c.html(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Authentication Failed</title>
              <style>
                body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f87171; color: #0f172a; }
                .card { background: white; border: 3px solid #0f172a; border-radius: 16px; padding: 24px; box-shadow: 6px 6px 0px #0f172a; text-align: center; max-width: 320px; }
                h2 { font-size: 18px; margin-top: 0; color: #dc2626; }
                p { font-size: 12px; font-weight: bold; }
              </style>
            </head>
            <body>
              <div class="card">
                <h2>⚠️ Authentication Failed</h2>
                <p>Could not exchange token with identity provider.</p>
              </div>
              <script>
                if (window.opener) {
                  window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: 'Token exchange failed' }, '*');
                  setTimeout(() => { window.close(); }, 2000);
                }
              </script>
            </body>
          </html>
        `);
      }

      const tokens: any = await tokenRes.json();

      const parseJwtPayload = (token?: string) => {
        if (!token || typeof token !== 'string') return null;
        try {
          const parts = token.split('.');
          if (parts.length !== 3) return null;
          const base64Url = parts[1];
          const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
          const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
          return JSON.parse(jsonStr);
        } catch {
          return null;
        }
      };

      const idPayload = parseJwtPayload(tokens.id_token);
      const accessPayload = parseJwtPayload(tokens.access_token);
      let userinfo: any = null;

      if (tokens.access_token) {
        try {
          const userinfoRes = await fetch(`${keycloakUrl}/protocol/openid-connect/userinfo`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          if (userinfoRes.ok) {
            userinfo = await userinfoRes.json();
          }
        } catch (e) {
          console.warn('Failed to fetch userinfo from Keycloak:', e);
        }
      }

      const sources = [userinfo, idPayload, accessPayload].filter(Boolean);

      const getEmail = () => {
        for (const s of sources) {
          if (s.email && typeof s.email === 'string' && s.email.trim()) {
            return s.email.trim();
          }
        }
        return '';
      };

      const formatName = (str: string) => {
        if (!str) return '';
        if (str.includes(' ') || (/[A-Z]/.test(str) && /[a-z]/.test(str))) return str;
        return str.replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      };

      const resolveName = (): string => {
        for (const s of sources) {
          if (s.name && typeof s.name === 'string' && s.name.trim() && !['Keycloak User', 'Member'].includes(s.name.trim())) {
            return s.name.trim();
          }
        }
        for (const s of sources) {
          if (s.given_name || s.family_name) {
            const full = `${s.given_name || ''} ${s.family_name || ''}`.trim();
            if (full && full !== 'undefined undefined') return full;
          }
        }
        for (const s of sources) {
          const uname = s.preferred_username || s.nickname || s.username;
          if (uname && typeof uname === 'string' && uname.trim()) {
            return formatName(uname.trim());
          }
        }
        const mail = getEmail();
        if (mail && mail.includes('@')) {
          const prefix = mail.split('@')[0];
          if (prefix) return formatName(prefix);
        }
        return 'Member';
      };

      const checkIsAdminGroup = (): boolean => {
        for (const s of sources) {
          if (!s || typeof s !== 'object') continue;

          const matchesAdmin = (val: any): boolean => {
            if (!val) return false;
            if (typeof val === 'string') {
              const clean = val.trim().toLowerCase();
              if (clean === 'admin' || clean === '/admin') return true;
              const parts = clean.split(/[\/\s,;:]+/).filter(Boolean);
              if (parts.includes('admin')) return true;
            } else if (typeof val === 'object') {
              if (val.name && matchesAdmin(val.name)) return true;
              if (val.path && matchesAdmin(val.path)) return true;
              if (val.id && matchesAdmin(val.id)) return true;
              if (val.group && matchesAdmin(val.group)) return true;
            }
            return false;
          };

          const recursiveCheck = (obj: any, depth = 0): boolean => {
            if (!obj || depth > 5) return false;
            if (typeof obj === 'string') return matchesAdmin(obj);
            if (Array.isArray(obj)) {
              for (const item of obj) {
                if (matchesAdmin(item) || recursiveCheck(item, depth + 1)) return true;
              }
            } else if (typeof obj === 'object') {
              for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (matchesAdmin(val) || recursiveCheck(val, depth + 1)) return true;
              }
            }
            return false;
          };

          if (recursiveCheck(s)) return true;
        }
        return false;
      };

      const verifiedName = resolveName();
      const verifiedEmail = getEmail();
      const verifiedIsAdmin = checkIsAdminGroup();

      const userData = {
        name: verifiedName,
        email: verifiedEmail,
        isAdmin: verifiedIsAdmin,
        authenticated: true,
        // Signed by the server after this Keycloak exchange was verified - the socket layer
        // trusts this token (never raw client-submitted name/email/isAdmin) for identity/admin.
        sessionToken: createSessionToken({ email: verifiedEmail, name: verifiedName, isAdmin: verifiedIsAdmin }),
      };

      return c.html(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Keycloak Auth Callback</title>
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fbbf24; color: #0f172a; }
              .card { background: white; border: 3px solid #0f172a; border-radius: 16px; padding: 24px; box-shadow: 6px 6px 0px #0f172a; text-align: center; max-width: 320px; }
              h2 { font-size: 18px; margin-top: 0; }
              p { font-size: 13px; font-weight: bold; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>🎉 Login Successful!</h2>
              <p>Welcome, ${userData.name}! Returning to peer-space...</p>
            </div>
            <script>
              const userData = ${JSON.stringify(userData)};
              if (window.opener) {
                try {
                  window.opener.postMessage({
                    type: 'OAUTH_AUTH_SUCCESS',
                    user: userData
                  }, '*');
                } catch (e) {
                  console.error('Failed to postMessage to opener:', e);
                }
                setTimeout(() => { window.close(); }, 800);
              } else {
                window.location.href = '/?auth_user=' + encodeURIComponent(JSON.stringify(userData));
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Keycloak OAuth callback error:', err);
      return c.text('OAuth callback processing error.', 500);
    }
  });

  // Serve static assets in production
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(process.cwd(), 'dist');
    app.use('*', serveStatic({ root: './dist' }));
    app.get('*', (c) => {
      try {
        const html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
        return c.html(html);
      } catch {
        return c.text('Not found', 404);
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    const scheme = useHttps ? 'https' : 'http';
    console.log(`PeerSpace Hono/Bun server running on ${scheme}://0.0.0.0:${PORT}`);
    if (useHttps) {
      const lanIps = Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
        .map((i) => i.address);
      lanIps.forEach((ip) => {
        console.log(`  -> Open this URL on your phone (same wifi) to test camera/mic: ${scheme}://${ip}:${PORT}`);
      });
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
