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
import { User, GridMap, ChatMessage, MapObject, WhiteboardStroke, StickyNote, PrivateZone, PresenceStatus } from './src/types';
import { createDefaultOfficeMap, createBeachRetreatMap } from './src/mapsData';
import { initWorkspaceDatabase } from './src/db';
import { createSessionToken, verifySessionToken } from './src/lib/session';
import { canDeleteNote } from './src/lib/notePermissions';
import { canClaimDesk, canManageDesk, isDeskEquipment } from './src/lib/deskPermissions';
import {
  createGameState,
  findWinner,
  GAME_SPECS,
  normalizeGameState,
  resolveMove,
  specFor,
  type GameTableGame,
} from './src/lib/gameTable';
import { isTileWalkable } from './src/lib/pathfinding';

async function startServer() {
  const app = new Hono();
  // Configurable so a second instance can be run alongside the main one (paired with
  // DATA_DIR, which already points the SQLite file elsewhere) without fighting over the port.
  const PORT = Number(process.env.PORT) || 3000;

  // Initialize SQLite persistence driver
  const db = await initWorkspaceDatabase();

  // In-memory application state
  const users: Map<string, User> = new Map(); // socket.id -> User
  // Per (from, to) pair cooldown for the chime feature, enforced server-side so a
  // misbehaving/hacked client can't spam someone regardless of any client-side disabling.
  const lastChimeAt: Map<string, number> = new Map();
  const CHIME_COOLDOWN_MS = 8000;

  // Available maps (Loaded from SQLite database or initialized with defaults)
  const maps: Map<string, GridMap> = new Map();
  const defaultOffice = createDefaultOfficeMap();
  const beachRetreat = createBeachRetreatMap();

  /**
   * Drops objects whose type no longer exists.
   *
   * Maps are persisted, so a saved map still contains every jukebox, TV and coffee machine
   * that was placed before those types were removed. Left in, they would render through
   * renderObject's fallback as anonymous grey blocks that still block movement, and clicking
   * one would open an empty modal. Stripping on load is a one-way migration: the next save
   * writes the cleaned map back.
   */
  const RETIRED_OBJECT_TYPES = new Set(['jukebox', 'tv', 'coffee_machine']);
  function stripRetiredObjects(map: GridMap): GridMap {
    const kept = (map.objects || []).filter((o) => !RETIRED_OBJECT_TYPES.has(o.type as string));
    const removed = (map.objects || []).length - kept.length;
    if (removed > 0) {
      console.log(`[maps] Removed ${removed} retired object(s) from "${map.name}".`);
    }
    return { ...map, objects: kept };
  }

  const savedMaps = db.loadMaps();
  if (savedMaps.length > 0) {
    savedMaps.forEach((m) => {
      const cleaned = stripRetiredObjects(m);
      maps.set(cleaned.id, cleaned);
      if (cleaned.objects.length !== (m.objects || []).length) db.saveMap(cleaned);
    });
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

  // Helper: is this tile currently stood on by some other connected user?
  function isOccupiedByOtherUser(x: number, y: number, excludeSocketId: string): boolean {
    for (const u of users.values()) {
      if (u.socketId !== excludeSocketId && u.position.x === x && u.position.y === y) {
        return true;
      }
    }
    return false;
  }

  // Helper: nearest walkable, unoccupied tile to `preferred` - used when a join/resume
  // position would otherwise land a new user directly on top of someone already there.
  function findFreeSpawnTile(
    map: GridMap,
    preferred: { x: number; y: number },
    excludeSocketId: string
  ): { x: number; y: number } {
    if (isTileWalkable(map, preferred.x, preferred.y) && !isOccupiedByOtherUser(preferred.x, preferred.y, excludeSocketId)) {
      return preferred;
    }
    for (let radius = 1; radius <= 10; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
          const x = preferred.x + dx;
          const y = preferred.y + dy;
          if (isTileWalkable(map, x, y) && !isOccupiedByOtherUser(x, y, excludeSocketId)) {
            return { x, y };
          }
        }
      }
    }
    return preferred; // give up - overlap is better than an infinite/failed join
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
    socket.on(
      'user:join',
      (payload: {
        name: string;
        avatar: any;
        isAdmin?: boolean;
        clientId?: string;
        email?: string;
        sessionToken?: string;
        lastPosition?: { mapId: string; x: number; y: number };
        presenceStatus?: PresenceStatus;
      }) => {
      const map = maps.get(currentMapId) || defaultOffice;

      // Resume where the browser last left off, as long as it was on this same map and the
      // tile is still walkable (map layout may have changed via the builder since then).
      const lp = payload.lastPosition;
      const preferredPosition =
        lp && lp.mapId === map.id && isTileWalkable(map, lp.x, lp.y)
          ? { x: lp.x, y: lp.y }
          : { ...map.spawnPoint };
      // Collision detection means two users can no longer share a tile - if the resume/spawn
      // tile is already taken, nudge the new arrival to the nearest free tile instead.
      const startPosition = findFreeSpawnTile(map, preferredPosition, socket.id);

      const initialZone = getPrivateZoneId(map, startPosition.x, startPosition.y);

      // isAdmin and a cross-device stable identity (email) can ONLY come from a verified
      // Keycloak session token - payload.isAdmin/email are otherwise fully client-controlled
      // and must never be trusted directly (that was previously a trivial privilege-escalation
      // hole: any client could just send { isAdmin: true }).
      const session = verifySessionToken(payload.sessionToken);

      // A token that was *supplied but did not verify* means the client is holding a stale
      // login - either past the 12h TTL, or signed with a secret from a previous server boot
      // (which is what happens on every restart whenever SESSION_SECRET is unset). Silently
      // treating that as "guest" is what made admin look broken rather than expired: the
      // client still shows the cached Admin badge it persisted to localStorage, while every
      // admin handler here rejects them. Tell the client so it can re-authenticate instead.
      if (payload.sessionToken && !session) {
        console.warn(
          `[auth] Stale session token from ${socket.id} - expired, or signed with a previous ` +
            `SESSION_SECRET. Asking the client to sign in again.`
        );
        socket.emit('auth:expired');
      }

      const isAdmin = session ? session.isAdmin : false;
      const email = session ? session.email : undefined;
      const displayName = session?.name || payload.name || `Guest_${socket.id.substring(0, 4)}`;

      // Prefer a stable identity that survives reloads/reconnects (socket.id is re-generated
      // every connection) - the verified email when authenticated, else the persisted
      // per-browser clientId, else fall back to socket.id for older/guest clients.
      const stableId = email || payload.clientId || socket.id;

      const validPresenceStatuses: PresenceStatus[] = ['available', 'busy', 'dnd'];
      const presenceStatus = validPresenceStatuses.includes(payload.presenceStatus as PresenceStatus)
        ? (payload.presenceStatus as PresenceStatus)
        : 'available';

      const newUser: User = {
        id: stableId,
        socketId: socket.id,
        name: displayName,
        position: startPosition,
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
        presenceStatus,
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
      }
    );

    // Handle User Movement
    socket.on('user:move', (data: { x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; ghost?: boolean }) => {
      const user = users.get(socket.id);
      if (!user) return;

      const map = maps.get(currentMapId);
      if (!map) return;

      const validDirections = ['up', 'down', 'left', 'right'];
      if (!validDirections.includes(data.direction)) return;

      /**
       * A blocked move still turns the character to face the way they tried to go.
       *
       * Every rejection below used to be a bare `return`, so walking into a wall left the
       * avatar facing whatever direction it happened to be facing already - most obviously
       * after arriving somewhere by click-to-move, where the facing is a side effect of the
       * last step of the path. Turning on the spot is always legal: it changes no position,
       * no zone and no collision, so it cannot be used to walk through anything.
       */
      const turnInPlace = () => {
        if (user.direction === data.direction) return;
        user.direction = data.direction;
        user.lastSeen = Date.now();
        io.emit('user:moved', {
          userId: socket.id,
          position: user.position,
          direction: user.direction,
          currentZoneId: user.currentZoneId,
        });
      };

      // Validate bounds
      if (data.x < 0 || data.x >= map.width || data.y < 0 || data.y >= map.height) {
        return turnInPlace();
      }

      // Check collision with tile or blocking map objects
      const targetTile = map.tiles[data.y]?.[data.x];
      if (targetTile === 'wall_brick' || targetTile === 'wall_wood' || targetTile === 'water') {
        return turnInPlace(); // blocked
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
        return turnInPlace(); // blocked
      }

      // Collision with other users - two people can no longer occupy the same tile, unless
      // the mover is holding Ghost mode (client sends `ghost: true` while "g" is held).
      // Authoritative here (not just client-side) so simultaneous moves from two clients
      // can't both land on the same tile via a race.
      if (!data.ghost && isOccupiedByOtherUser(data.x, data.y, socket.id)) {
        return turnInPlace(); // blocked
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
      if (updates.presenceStatus && ['available', 'busy', 'dnd'].includes(updates.presenceStatus)) {
        user.presenceStatus = updates.presenceStatus;
      }

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

    // Chime: ring a colleague's client to get their attention (particularly meant for
    // reaching someone marked Busy/DND, but works on anyone).
    socket.on(
      'user:chime',
      (payload: { to: string }, ack?: (r: { ok: boolean; reason?: string; name?: string }) => void) => {
        // Acknowledged so the sender learns what happened. Ringing someone is a request for
        // their attention, and every outcome here used to be a silent `return` - so a
        // rate-limited ring and a delivered one looked identical from the sending side.
        const reply = (ok: boolean, reason?: string, name?: string) => {
          if (typeof ack === 'function') ack({ ok, reason, name });
        };

        const sender = users.get(socket.id);
        const target = users.get(payload?.to);
        if (!sender) return reply(false, 'not_joined');
        if (!target || target.socketId === sender.socketId) return reply(false, 'gone');

        const key = `${sender.socketId}->${target.socketId}`;
        const now = Date.now();
        const last = lastChimeAt.get(key) || 0;
        if (now - last < CHIME_COOLDOWN_MS) {
          return reply(false, 'rate_limited', target.name);
        }
        lastChimeAt.set(key, now);

        io.to(target.socketId).emit('chime:received', {
          fromSocketId: sender.socketId,
          fromName: sender.name,
        });
        reply(true, undefined, target.name);
      }
    );

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

      const author = users.get(socket.id);
      if (!author || !payload?.note) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (!obj) return;

      // Authorship is stamped from the connection, not taken from the payload: a client
      // could otherwise post under someone else's name, and authorId is what deletion is
      // authorised against, so it has to mean something.
      const note: StickyNote = {
        id: typeof payload.note.id === 'string' ? payload.note.id : `note_${Date.now()}`,
        text: String(payload.note.text ?? '').slice(0, 500),
        color: typeof payload.note.color === 'string' ? payload.note.color : '#fef08a',
        createdAt: Date.now(),
        author: author.name,
        authorId: author.id,
      };
      if (!note.text.trim()) return;

      if (obj.type === 'sticky_notes') {
        if (!obj.data) obj.data = {};
        if (!obj.data.notes) obj.data.notes = [];
        obj.data.notes.push(note);

        io.emit('object:notes_updated', {
          objectId: payload.objectId,
          notes: obj.data.notes,
        });

        persistCurrentMap();
        return;
      }

      // Desk notes go through this path too, so that leaving a note is the *only* way to
      // change someone else's desk - it can append, and nothing else.
      if (obj.type === 'desk' || obj.type === 'computer') {
        obj.data = obj.data || {};
        const state = obj.data.deskState || {};
        obj.data.deskState = { ...state, stickyNotes: [note, ...(state.stickyNotes || [])] };

        io.emit('map:object_updated', { objectId: payload.objectId, object: obj });
        persistCurrentMap();
      }
    });

    // Game move
    socket.on('object:game_move', (payload: { objectId: string; index: number; symbol: 'X' | 'O' }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (!obj || obj.type !== 'game_table' || !obj.data?.gameState) return;

      const state = normalizeGameState(obj.data.gameState);
      obj.data.gameState = state;

      // Turn order is enforced here rather than only in the modal. Without it a client could
      // play both colours and simply drop four of its own discs in a row.
      if (payload.symbol !== state.turn) return;

      // The client sends the cell it clicked; for 4-to-Win the server decides where that disc
      // actually lands, so a hand-crafted payload cannot float one in mid-air.
      const target = resolveMove(state, payload.index);
      if (target === null) return;

      state.board[target] = payload.symbol;
      state.turn = payload.symbol === 'X' ? 'O' : 'X';
      state.winner = findWinner(state.board, specFor(state.game));

      io.emit('object:game_updated', {
        objectId: payload.objectId,
        gameState: state,
      });

      persistCurrentMap();
    });

    // Reset Game (also how the table is switched between games)
    socket.on('object:game_reset', (payload: { objectId: string; game?: GameTableGame }) => {
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (!obj || obj.type !== 'game_table' || !obj.data?.gameState) return;

      const current = normalizeGameState(obj.data.gameState);
      const nextGame = payload.game && GAME_SPECS[payload.game] ? payload.game : current.game;
      obj.data.gameState = createGameState(nextGame);

      io.emit('object:game_updated', {
        objectId: payload.objectId,
        gameState: obj.data.gameState,
      });

      persistCurrentMap();
    });

    /**
     * Deleting a sticky note, from either the bulletin board or a desk.
     *
     * Its own event rather than part of any bulk update: object:add_note only ever appends,
     * and nothing else is allowed to write a note list at all, so removal is the one path
     * that can take a note away and it authorises every removal itself.
     *
     * Notes carry a display name and (since this change) an authorId. Only the id is used to
     * authorise - a name is chosen by the user and is neither unique nor verified, so two
     * people called Alex could otherwise delete each other's notes. Notes written before
     * authorId existed have none and can only be cleared by an admin.
     */
    socket.on(
      'object:delete_note',
      (payload: { objectId: string; noteId: string }, ack?: (r: { ok: boolean; reason?: string }) => void) => {
      // Acknowledged so a refused or unhandled delete is visible. Every failure path here is
      // a silent `return`, which is what made a stale server (one started before this handler
      // existed) look identical to a working one that simply declined.
      const reply = (ok: boolean, reason?: string) => {
        if (typeof ack === 'function') ack({ ok, reason });
      };

      const map = maps.get(currentMapId);
      if (!map) return reply(false, 'no_map');

      const user = users.get(socket.id);
      if (!user || !payload?.objectId || !payload?.noteId) return reply(false, 'bad_request');

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (!obj) return reply(false, 'no_object');

      if (obj.type === 'sticky_notes') {
        const notes = obj.data?.notes;
        const note = notes?.find((n) => n.id === payload.noteId);
        if (!notes || !note) return reply(false, 'no_note');
        if (!canDeleteNote(user, note)) return reply(false, 'not_allowed');

        obj.data!.notes = notes.filter((n) => n.id !== payload.noteId);
        io.emit('object:notes_updated', { objectId: payload.objectId, notes: obj.data!.notes });
        persistCurrentMap();
        return reply(true);
      }

      if (obj.type === 'desk' || obj.type === 'computer') {
        const deskState = obj.data?.deskState;
        const notes = deskState?.stickyNotes;
        const note = notes?.find((n) => n.id === payload.noteId);
        if (!deskState || !notes || !note) return reply(false, 'no_note');
        if (!canDeleteNote(user, note, deskState)) return reply(false, 'not_allowed');

        deskState.stickyNotes = notes.filter((n) => n.id !== payload.noteId);
        io.emit('map:object_updated', { objectId: payload.objectId, object: obj });
        persistCurrentMap();
        return reply(true);
      }

      return reply(false, 'unsupported_object');
    }
  );

    /**
     * Desks used to be updated by a single object:desk_updated event that took a whole
     * deskState and wrote it straight in, with no authorisation at all - so any client could
     * unclaim someone else's desk, reassign it to themselves under any name, rewrite its
     * status, or wipe its notes.
     *
     * These replace it with one handler per intent. None of them accept state from the
     * client: the claimant is taken from the connection, equipment is checked against the
     * allowed set, and notes are only ever touched through object:add_note and
     * object:delete_note, which do their own authorisation.
     */
    function findDesk(objectId: string): MapObject | null {
      const map = maps.get(currentMapId);
      if (!map) return null;
      const obj = map.objects.find((o) => o.id === objectId);
      return obj && (obj.type === 'desk' || obj.type === 'computer') ? obj : null;
    }

    function broadcastDesk(desk: MapObject) {
      io.emit('map:object_updated', { objectId: desk.id, object: desk });
      persistCurrentMap();
    }

    socket.on('object:desk_claim', (payload: { objectId: string }) => {
      const user = users.get(socket.id);
      const desk = payload?.objectId ? findDesk(payload.objectId) : null;
      if (!user || !desk) return;

      desk.data = desk.data || {};
      const state = desk.data.deskState || {};
      if (!canClaimDesk(user, state)) return;

      desk.data.deskState = {
        ...state,
        claimedByUserId: user.id,
        claimedByUserName: user.name,
        deskLabel: `${user.name}'s Desk`,
        statusNote: state.statusNote || '💻 Working at my desk',
      };
      broadcastDesk(desk);
    });

    socket.on('object:desk_release', (payload: { objectId: string }) => {
      const user = users.get(socket.id);
      const desk = payload?.objectId ? findDesk(payload.objectId) : null;
      if (!user || !desk) return;

      const state = desk.data?.deskState;
      if (!canManageDesk(user, state)) return;

      // deskLabel is cleared rather than set to a placeholder so the object's original map
      // name ("Workstation 1") shows through again - the canvas already prefers the label
      // when there is one, which is why obj.name no longer gets overwritten on claim.
      desk.data!.deskState = {
        ...state,
        claimedByUserId: undefined,
        claimedByUserName: undefined,
        deskLabel: undefined,
        statusNote: '',
      };
      broadcastDesk(desk);
    });

    socket.on(
      'object:desk_settings',
      (payload: { objectId: string; statusNote?: string; equipment?: string }) => {
        const user = users.get(socket.id);
        const desk = payload?.objectId ? findDesk(payload.objectId) : null;
        if (!user || !desk) return;

        const state = desk.data?.deskState;
        if (!canManageDesk(user, state)) return;

        desk.data!.deskState = {
          ...state,
          statusNote:
            typeof payload.statusNote === 'string' ? payload.statusNote.slice(0, 140) : state!.statusNote,
          equipment: isDeskEquipment(payload.equipment) ? payload.equipment : state!.equipment,
        };
        broadcastDesk(desk);
      }
    );

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
    socket.on("map:place_object", (newObj: MapObject) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      map.objects.push(newObj);
      io.emit("map:object_placed", newObj);
      persistCurrentMap();
    });

    // Map Builder - Move Object
    socket.on("map:move_object", (payload: { objectId: string; x: number; y: number }) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj) {
        obj.x = payload.x;
        obj.y = payload.y;
        io.emit("map:object_updated", { objectId: payload.objectId, object: obj });
        persistCurrentMap();
      }
    });

    // Map Builder - Remove Object
    socket.on("map:remove_object", (objectId: string) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = maps.get(currentMapId);
      if (!map) return;

      map.objects = map.objects.filter((o) => o.id !== objectId);
      io.emit("map:object_removed", objectId);
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

      // Drop any chime cooldown entries involving this socket so the map doesn't grow forever.
      for (const key of lastChimeAt.keys()) {
        if (key.startsWith(`${socket.id}->`) || key.endsWith(`->${socket.id}`)) {
          lastChimeAt.delete(key);
        }
      }
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
