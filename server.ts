import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import crypto from "crypto";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server, Socket } from "socket.io";
import path from "path";
import fs from "fs";
import os from "os";
import { createServer as createViteServer } from "vite";
import {
  User,
  GridMap,
  ChatMessage,
  MapObject,
  WhiteboardStroke,
  StickyNote,
  PrivateZone,
  PresenceStatus,
  Direction,
  Space,
  SpaceSummary,
} from "./src/types";
import {
  createDefaultOfficeMap,
  createBeachRetreatMap,
  createRaceTrackMap,
  needsRaceTrackUpgrade,
} from "./src/mapsData";
import { initWorkspaceDatabase } from "./src/db";
import {
  createSessionToken,
  getSessionSecret,
  verifySessionToken,
} from "./src/lib/session";
import {
  canRevoke,
  isAdminEmail,
  listAdmins,
  normalizeAdminEmail,
  parseAdminEmails,
} from "./src/lib/admins";
import {
  buildAuthUrl,
  createPkce,
  decodeJwtPayload,
  exchangeCode,
  openLoginState,
  randomToken,
  sealLoginState,
  validateIdTokenClaims,
} from "./src/lib/googleAuth";
import { validAnnounce } from "./src/lib/media/wire";
import {
  checkBearer,
  isEndpointIdHex,
  RelayAccessRegistry,
} from "./src/lib/relayAccess";
import { parseRelayList } from "./src/lib/media/transport";
import { canDeleteNote } from "./src/lib/notePermissions";
import {
  canClaimDesk,
  canManageDesk,
  isDeskEquipment,
} from "./src/lib/deskPermissions";
import {
  createGameState,
  findWinner,
  GAME_SPECS,
  normalizeGameState,
  resolveMove,
  specFor,
  type GameTableGame,
} from "./src/lib/gameTable";
import { isTileWalkable } from "./src/lib/pathfinding";
import { privateZoneIdAt } from "./src/lib/privateZones";
import {
  findFreeTileNear,
  headingFromDirection,
  isTileBlocked,
  planPortal,
  portalAt,
  resolvePortalTargetId,
  resolveSpaceMapId,
  tileAt,
  validateKartMove,
} from "./src/lib/portals";
import { directionFromHeading, normalizeAngle } from "./src/lib/kart";
import { DEFAULT_KART_MODEL, isKartModel } from "./src/lib/kartModels";
import {
  canEnterSpace,
  normalizeEmails,
  spacesFor,
} from "./src/lib/spaceAccess";

async function startServer() {
  const app = new Hono();
  // Configurable so a second instance can be run alongside the main one (paired with
  // DATA_DIR, which already points the SQLite file elsewhere) without fighting over the port.
  const PORT = Number(process.env.PORT) || 3000;

  // Initialize SQLite persistence driver
  const db = await initWorkspaceDatabase();

  // Admins are ADMIN_EMAILS (configuration, cannot be revoked in the app) plus the admins granted
  // in the app and stored in the DB. Both are kept as normalized emails. Admin status is always
  // resolved from a verified email here; nothing the client sends decides it.
  const envAdmins = parseAdminEmails(process.env.ADMIN_EMAILS);
  const dbAdmins = new Set(db.listDbAdmins().map((a) => a.email));
  if (envAdmins.size === 0 && dbAdmins.size === 0) {
    console.warn(
      "[admin] no admins configured - set ADMIN_EMAILS or grant an admin from the app.",
    );
  }
  function isAdmin(email: string | undefined | null): boolean {
    return isAdminEmail(email, envAdmins, dbAdmins);
  }

  // In-memory application state
  const users: Map<string, User> = new Map(); // socket.id -> User
  // Verified (lower-case) email of each joined socket, from its session token. Kept beside the
  // users map rather than on User so admin checks and grant/revoke can find a user's email.
  const socketEmails: Map<string, string> = new Map();
  // Which iroh endpoint each joined socket may use on the self-hosted relay (see relayAccess.ts).
  const relayAccess = new RelayAccessRegistry();
  // Per (from, to) pair cooldown for the chime feature, enforced server-side so a
  // misbehaving/hacked client can't spam someone regardless of any client-side disabling.
  const lastChimeAt: Map<string, number> = new Map();
  const CHIME_COOLDOWN_MS = 8000;

  // Available maps (Loaded from SQLite database or initialized with defaults)
  const maps: Map<string, GridMap> = new Map();
  const defaultOffice = createDefaultOfficeMap();
  const beachRetreat = createBeachRetreatMap();
  const raceTrack = createRaceTrackMap();

  /**
   * Drops objects whose type no longer exists.
   *
   * Maps are persisted, so a saved map still contains every jukebox, TV and coffee machine
   * that was placed before those types were removed. Left in, they would render through
   * renderObject's fallback as anonymous grey blocks that still block movement, and clicking
   * one would open an empty modal. Stripping on load is a one-way migration: the next save
   * writes the cleaned map back.
   */
  const RETIRED_OBJECT_TYPES = new Set(["jukebox", "tv", "coffee_machine"]);
  function stripRetiredObjects(map: GridMap): GridMap {
    const kept = (map.objects || []).filter(
      (o) => !RETIRED_OBJECT_TYPES.has(o.type as string),
    );
    const removed = (map.objects || []).length - kept.length;
    if (removed > 0) {
      console.log(
        `[maps] Removed ${removed} retired object(s) from "${map.name}".`,
      );
    }
    return { ...map, objects: kept };
  }

  const savedMaps = db.loadMaps();
  if (savedMaps.length > 0) {
    savedMaps.forEach((m) => {
      const cleaned = stripRetiredObjects(m);
      maps.set(cleaned.id, cleaned);
      if (cleaned.objects.length !== (m.objects || []).length)
        db.saveMap(cleaned);
    });
  } else {
    maps.set(defaultOffice.id, defaultOffice);
    maps.set(beachRetreat.id, beachRetreat);
    maps.set(raceTrack.id, raceTrack);
    db.saveMap(defaultOffice);
    db.saveMap(beachRetreat);
    db.saveMap(raceTrack);
  }

  // Spaces: isolated worlds, each owning its maps and its own active map. Users, chat, voice
  // proximity and map edits never cross a space boundary.
  const spaces: Map<string, Space> = new Map();
  const DEFAULT_SPACE_ID = "main";

  const savedSpaces = db.loadSpaces();
  if (savedSpaces.length > 0) {
    savedSpaces.forEach((sp) => spaces.set(sp.id, sp));
  } else {
    // First boot on a pre-spaces database (or a fresh one): everything that exists so far
    // becomes the default space. It is open to all so nobody is locked out by the upgrade;
    // an admin can restrict it afterwards.
    const legacyActive = db.loadActiveMapId();
    const main: Space = {
      id: DEFAULT_SPACE_ID,
      name: "Main Space",
      activeMapId:
        legacyActive && maps.has(legacyActive)
          ? legacyActive
          : defaultOffice.id,
      memberEmails: [],
      openToAll: true,
    };
    spaces.set(main.id, main);
    db.saveSpace(main);
  }

  // Maps saved before spaces existed have no owner; they belong to the default space.
  const fallbackSpaceId = spaces.has(DEFAULT_SPACE_ID)
    ? DEFAULT_SPACE_ID
    : [...spaces.keys()][0];
  for (const m of maps.values()) {
    if (!m.spaceId) {
      m.spaceId = fallbackSpaceId;
      db.saveMap(m);
    }
  }

  // Fresh copies of the preset maps for a new space. Map ids are globally unique in the
  // database, so they are namespaced by space. The race track is last: the first map is the
  // space's active map.
  function seedSpaceMaps(spaceId: string): GridMap[] {
    return [createDefaultOfficeMap(), createBeachRetreatMap(), createRaceTrackMap()].map((base) => {
      const map: GridMap = { ...base, id: `${spaceId}:${base.id}`, spaceId };
      maps.set(map.id, map);
      db.saveMap(map);
      return map;
    });
  }

  // A space must always point at one of its own maps.
  function ensureValidActiveMap(space: Space) {
    const own = [...maps.values()].filter((m) => m.spaceId === space.id);
    if (own.some((m) => m.id === space.activeMapId)) return;
    if (own.length === 0) own.push(...seedSpaceMaps(space.id));
    space.activeMapId = own[0].id;
    db.saveSpace(space);
  }
  spaces.forEach(ensureValidActiveMap);

  // Backfill for spaces that predate the race track and the office portal. Runs on every boot
  // and changes nothing once applied: a space gets a race track only if it has none, and its
  // office gets a portal only if it has none (so beach and other maps are never touched).
  function backfillRaceTrackAndPortals() {
    for (const space of spaces.values()) {
      if (!resolveSpaceMapId(space.id, "race_track", (id) => maps.get(id))) {
        const id = `${space.id}:race_track`;
        const race: GridMap = { ...createRaceTrackMap(), id, spaceId: space.id };
        maps.set(id, race);
        db.saveMap(race);
        console.log(`[maps] Added race track map "${id}" to space "${space.name}".`);
      }

      const officeId = resolveSpaceMapId(space.id, "office_default", (id) => maps.get(id));
      const office = officeId ? maps.get(officeId) : undefined;
      if (!office || office.objects.some((o) => o.type === "portal")) continue;
      const portal = planPortal(office, {
        id: "portal_race_track",
        name: "Race track",
        target: "race_track",
        label: "Race track",
      });
      if (!portal) {
        console.warn(`[maps] No free tile for a race track portal in "${office.id}".`);
        continue;
      }
      office.objects.push(portal);
      db.saveMap(office);
      console.log(
        `[maps] Added race track portal to "${office.id}" (space "${space.name}") at ${portal.x},${portal.y}.`,
      );
    }
  }
  backfillRaceTrackAndPortals();

  // Race tracks saved at an older size are rewritten to the current preset on boot. The id,
  // space and name are kept; the layout comes from the preset. Idempotent: a track already at
  // the preset's size is left alone. No one is connected yet, so no one needs relocating.
  function upgradeRaceTracks() {
    const tracks = new Set<GridMap>();
    for (const space of spaces.values()) {
      const id = resolveSpaceMapId(space.id, "race_track", (mid) => maps.get(mid));
      const track = id ? maps.get(id) : undefined;
      if (track) tracks.add(track);
    }
    const bare = maps.get("race_track");
    if (bare) tracks.add(bare);
    for (const track of tracks) {
      if (!needsRaceTrackUpgrade(track)) continue;
      // A fresh preset per track: the arrays must not be shared between maps.
      const preset = createRaceTrackMap();
      Object.assign(track, {
        width: preset.width,
        height: preset.height,
        tiles: preset.tiles,
        objects: preset.objects,
        spawnPoint: preset.spawnPoint,
        allowKarts: preset.allowKarts,
        mapWideMedia: preset.mapWideMedia,
        privateZones: preset.privateZones,
        presetVersion: preset.presetVersion,
      });
      db.saveMap(track);
      const owner = spaces.get(track.spaceId ?? "")?.name ?? track.spaceId;
      console.log(`[maps] Upgraded race track for space "${owner}" to ${track.width}x${track.height}`);
    }
  }
  upgradeRaceTracks();

  const room = (spaceId: string) => `space:${spaceId}`;
  // One socket room per map. Map edits go only to the people standing on that map, so racers
  // never hear about office edits and the reverse.
  const mapRoom = (mapId: string) => `map:${mapId}`;
  const spaceIdOf = (socketId: string) => users.get(socketId)?.spaceId;
  const usersIn = (spaceId: string | undefined) =>
    spaceId
      ? Array.from(users.values()).filter((u) => u.spaceId === spaceId)
      : [];
  const usersOn = (mapId: string | undefined) =>
    mapId ? Array.from(users.values()).filter((u) => u.mapId === mapId) : [];
  function spaceMap(spaceId: string | undefined): GridMap | undefined {
    const space = spaceId ? spaces.get(spaceId) : undefined;
    return space ? maps.get(space.activeMapId) : undefined;
  }
  // The map a user is on: their own map, or the space's active map if they have none.
  function mapOfUser(user: User | undefined): GridMap | undefined {
    if (!user) return undefined;
    const own = user.mapId ? maps.get(user.mapId) : undefined;
    if (own && own.spaceId === user.spaceId) return own;
    return spaceMap(user.spaceId);
  }
  const userMap = (socketId: string) => mapOfUser(users.get(socketId));
  // Emits to everyone on one map.
  const toMap = (mapId: string) => io.to(mapRoom(mapId));
  // Emits to everyone in the sender's space, and nobody else.
  const toSpace = (socketId: string) => io.to(room(spaceIdOf(socketId) ?? ""));

  // Puts a user on a map: records it, clears any kart, and moves their socket between map
  // rooms. Dummies have no socket, so for them only the record changes.
  function moveUserToMap(user: User, mapId: string) {
    const previous = user.mapId;
    user.mapId = mapId;
    user.kart = null;
    if (previous === mapId) return;
    const s = io.sockets.sockets.get(user.socketId);
    if (!s) return;
    if (previous) s.leave(mapRoom(previous));
    s.join(mapRoom(mapId));
  }

  // The map a portal target names, within one space. '@main' is the active map.
  function resolveTargetMap(
    spaceId: string | undefined,
    target: unknown,
  ): GridMap | undefined {
    const space = spaceId ? spaces.get(spaceId) : undefined;
    if (!space || typeof target !== "string") return undefined;
    const id = resolvePortalTargetId(space.id, space.activeMapId, target, (x) =>
      maps.get(x),
    );
    return id ? maps.get(id) : undefined;
  }

  // Portal cooldown per socket: stops a user bouncing between two maps on consecutive moves.
  const lastPortalAt: Map<string, number> = new Map();
  const PORTAL_COOLDOWN_MS = 1000;

  function persistMap(map: GridMap | undefined) {
    if (map) db.saveMap(map);
  }

  let vite: any;
  if (process.env.NODE_ENV !== "production") {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
  }

  const listener = getRequestListener(app.fetch);

  const requestHandler = (
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
  ) => {
    const url = req.url || "";
    if (url.startsWith("/api/") || url.startsWith("/auth/") || url.startsWith("/internal/")) {
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
  // plain http:// doesn't qualify - so testing camera/mic features from a phone needs this.
  const devCertPath = path.resolve(__dirname, "certs/dev-cert.pem");
  const devKeyPath = path.resolve(__dirname, "certs/dev-key.pem");
  const useHttps =
    process.env.NODE_ENV !== "production" &&
    fs.existsSync(devCertPath) &&
    fs.existsSync(devKeyPath);

  const httpServer = useHttps
    ? createHttpsServer(
        {
          cert: fs.readFileSync(devCertPath),
          key: fs.readFileSync(devKeyPath),
        },
        requestHandler,
      )
    : createServer(requestHandler);

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Helper: is this tile currently stood on by some other user on the same map? Users on other
  // maps never count. Positions are compared by the tile they round into. With `walkersOnly`,
  // people driving karts do not count (used when a kart driver steps out onto a tile).
  function isOccupiedByOtherUser(
    mapId: string | undefined,
    x: number,
    y: number,
    excludeSocketId: string,
    forAdmin = false,
    walkersOnly = false,
  ): boolean {
    for (const u of usersOn(mapId)) {
      if (u.socketId === excludeSocketId) continue;
      if (walkersOnly && u.kart) continue;
      const tile = tileAt(u.position);
      if (tile.x === x && tile.y === y) {
        if (u.isDummy && !forAdmin) continue;
        return true;
      }
    }
    return false;
  }

  // Helper: nearest walkable, unoccupied tile to `preferred` - used when a join/resume
  // position would otherwise land a new user directly on top of someone already there.
  // Never a portal tile, so a user is not dropped onto one without walking onto it.
  function findFreeSpawnTile(
    map: GridMap,
    preferred: { x: number; y: number },
    excludeSocketId: string,
    forAdmin = false,
  ): { x: number; y: number } {
    // Give up with the preferred tile: overlap is better than an infinite/failed join.
    return (
      findFreeTileNear(map, preferred, {
        maxRadius: 10,
        isTaken: (x, y) =>
          isOccupiedByOtherUser(map.id, x, y, excludeSocketId, forAdmin),
      }) ?? preferred
    );
  }

  // Emit an event only to connected admin users (excluding dummies)
  function emitToAdmins(spaceId: string | undefined, eventName: string, data: any) {
    for (const u of usersIn(spaceId)) {
      if (u.isAdmin && !u.isDummy) {
        io.to(u.socketId).emit(eventName, data);
      }
    }
  }

  // Broadcast a user-list event, hiding dummies from non-admin viewers. With `mapId`, only the
  // people standing on that map are sent it (for map events such as zone changes).
  function broadcastUsersWithFilter(
    spaceId: string | undefined,
    eventName: string,
    makePayload: (userList: User[]) => any,
    mapId?: string,
  ) {
    const allUsers = usersIn(spaceId);
    const publicUsers = allUsers.filter((u) => !u.isDummy);

    for (const u of allUsers) {
      if (u.isDummy) continue;
      if (mapId !== undefined && u.mapId !== mapId) continue;
      io.to(u.socketId).emit(
        eventName,
        makePayload(u.isAdmin ? allUsers : publicUsers),
      );
    }
  }

  // Re-resolves admin status for every joined user with this email after a grant or revoke, and
  // tells each of their spaces. Dummies are admin test users, never matched by email.
  function refreshAdminStatus(email: string) {
    for (const [socketId, userEmail] of socketEmails) {
      if (userEmail !== email) continue;
      const target = users.get(socketId);
      if (!target || target.isDummy) continue;
      target.isAdmin = isAdmin(email);
      toSpace(socketId).emit("user:updated", target);
    }
  }

  // Socket.IO event handlers
  io.on("connection", (socket: Socket) => {
    console.log(`User connected: ${socket.id}`);

    // ==========================================
    // SPACES (listing, and admin management)
    // Authenticated per call by the signed session token, since none of this happens after a
    // user:join - the picker runs before the user is in any space.
    // ==========================================
    function summarize(space: Space, admin: boolean): SpaceSummary {
      return {
        id: space.id,
        name: space.name,
        onlineCount: usersIn(space.id).filter((u) => !u.isDummy).length,
        ...(admin
          ? { memberEmails: space.memberEmails, openToAll: space.openToAll }
          : {}),
      };
    }

    function listFor(session: { email: string }) {
      const admin = isAdmin(session.email);
      return spacesFor(spaces.values(), { email: session.email, isAdmin: admin }).map(
        (sp) => summarize(sp, admin),
      );
    }

    type SpaceAck = (r: {
      ok: boolean;
      reason?: string;
      spaces?: SpaceSummary[];
    }) => void;

    // Shared prologue: verified session, plus an admin check for management calls.
    function authorize(
      token: unknown,
      ack: SpaceAck | undefined,
      requireAdmin: boolean,
    ) {
      const reply = (r: Parameters<SpaceAck>[0]) => {
        if (typeof ack === "function") ack(r);
      };
      const session = verifySessionToken(token);
      if (!session) {
        reply({ ok: false, reason: "unauthenticated" });
        return null;
      }
      if (requireAdmin && !isAdmin(session.email)) {
        reply({ ok: false, reason: "not_allowed" });
        return null;
      }
      return { session, reply };
    }

    socket.on(
      "spaces:list",
      (payload: { sessionToken?: string }, ack?: SpaceAck) => {
        const auth = authorize(payload?.sessionToken, ack, false);
        if (!auth) return;
        auth.reply({ ok: true, spaces: listFor(auth.session) });
      },
    );

    socket.on(
      "spaces:create",
      (
        payload: {
          sessionToken?: string;
          name?: string;
          memberEmails?: string[];
          openToAll?: boolean;
        },
        ack?: SpaceAck,
      ) => {
        const auth = authorize(payload?.sessionToken, ack, true);
        if (!auth) return;

        const name = String(payload.name ?? "").trim().slice(0, 60);
        if (!name) return auth.reply({ ok: false, reason: "name_required" });

        const space: Space = {
          id: `space_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`,
          name,
          activeMapId: "",
          memberEmails: normalizeEmails(payload.memberEmails),
          openToAll: payload.openToAll === true,
        };
        space.activeMapId = seedSpaceMaps(space.id)[0].id;
        spaces.set(space.id, space);
        db.saveSpace(space);
        auth.reply({ ok: true, spaces: listFor(auth.session) });
      },
    );

    socket.on(
      "spaces:update",
      (
        payload: {
          sessionToken?: string;
          spaceId?: string;
          name?: string;
          memberEmails?: string[];
          openToAll?: boolean;
        },
        ack?: SpaceAck,
      ) => {
        const auth = authorize(payload?.sessionToken, ack, true);
        if (!auth) return;

        const space = payload.spaceId ? spaces.get(payload.spaceId) : undefined;
        if (!space) return auth.reply({ ok: false, reason: "no_space" });

        if (typeof payload.name === "string") {
          const name = payload.name.trim().slice(0, 60);
          if (name) space.name = name;
        }
        if (payload.memberEmails !== undefined) {
          space.memberEmails = normalizeEmails(payload.memberEmails);
        }
        if (typeof payload.openToAll === "boolean") {
          space.openToAll = payload.openToAll;
        }
        db.saveSpace(space);
        auth.reply({ ok: true, spaces: listFor(auth.session) });
      },
    );

    socket.on(
      "spaces:delete",
      (payload: { sessionToken?: string; spaceId?: string }, ack?: SpaceAck) => {
        const auth = authorize(payload?.sessionToken, ack, true);
        if (!auth) return;

        const space = payload.spaceId ? spaces.get(payload.spaceId) : undefined;
        if (!space) return auth.reply({ ok: false, reason: "no_space" });
        if (spaces.size <= 1) return auth.reply({ ok: false, reason: "last_space" });
        if (usersIn(space.id).some((u) => !u.isDummy))
          return auth.reply({ ok: false, reason: "space_occupied" });

        // Dummies are admin test users; they go with the space.
        for (const u of usersIn(space.id)) users.delete(u.socketId);
        for (const m of [...maps.values()]) {
          if (m.spaceId === space.id) {
            maps.delete(m.id);
            db.deleteMap(m.id);
          }
        }
        spaces.delete(space.id);
        db.deleteSpace(space.id);
        auth.reply({ ok: true, spaces: listFor(auth.session) });
      },
    );

    // ==========================================
    // ADMIN MANAGEMENT
    // Admin-only: the caller's joined email must be an admin on the server's list. Each event
    // replies through its ack with { ok, error?, admins? }.
    // ==========================================
    type AdminAck = (r: {
      ok: boolean;
      error?: string;
      admins?: ReturnType<typeof listAdmins>;
    }) => void;

    // Socket.IO passes the ack as the last argument; find it wherever the client put it.
    function ackOf(args: unknown[]): AdminAck {
      const fn = args.find((a) => typeof a === "function") as AdminAck | undefined;
      return (r) => {
        if (fn) fn(r);
      };
    }

    // The joined admin's email, or null when the socket is not joined or is not an admin.
    function adminActor(): string | null {
      if (!users.has(socket.id)) return null;
      const email = socketEmails.get(socket.id);
      return isAdmin(email) && email ? email : null;
    }

    // The account an admin grant/revoke applies to. Either an email, or a socketId whose verified
    // email the server looks up, so clients never need to be sent other users' emails.
    type AdminTarget = { ok: true; email: string } | { ok: false; error: string };
    function adminTarget(args: unknown[]): AdminTarget {
      const payload = args[0] as
        | { email?: unknown; socketId?: unknown }
        | null
        | undefined;
      if (typeof payload?.socketId === "string") {
        const email = socketEmails.get(payload.socketId);
        if (!email || users.get(payload.socketId)?.isDummy) {
          return { ok: false, error: "That user has no verified email." };
        }
        return { ok: true, email };
      }
      const email = normalizeAdminEmail(payload?.email);
      if (!email) return { ok: false, error: "Not a valid email address." };
      return { ok: true, email };
    }

    socket.on("admin:list", (...args: unknown[]) => {
      const reply = ackOf(args);
      if (!adminActor()) return reply({ ok: false, error: "not_allowed" });
      reply({ ok: true, admins: listAdmins(envAdmins, dbAdmins) });
    });

    socket.on("admin:grant", (...args: unknown[]) => {
      const reply = ackOf(args);
      const actor = adminActor();
      if (!actor) return reply({ ok: false, error: "not_allowed" });
      const target = adminTarget(args);
      if (target.ok === false) return reply({ ok: false, error: target.error });
      const email = target.email;

      db.addDbAdmin(email, actor);
      dbAdmins.add(email);
      refreshAdminStatus(email);
      reply({ ok: true, admins: listAdmins(envAdmins, dbAdmins) });
    });

    socket.on("admin:revoke", (...args: unknown[]) => {
      const reply = ackOf(args);
      const actor = adminActor();
      if (!actor) return reply({ ok: false, error: "not_allowed" });
      const target = adminTarget(args);
      if (target.ok === false) return reply({ ok: false, error: target.error });
      const email = target.email;

      const check = canRevoke(email, envAdmins);
      if (check.ok === false) return reply({ ok: false, error: check.reason });
      // Revoking your own access would lock you out, so an admin cannot do it to themselves.
      if (email === actor) {
        return reply({ ok: false, error: "You cannot revoke your own admin access." });
      }

      const removed = db.removeDbAdmin(email);
      dbAdmins.delete(email);
      if (!removed) return reply({ ok: false, error: "Not an app-granted admin." });
      refreshAdminStatus(email);
      reply({ ok: true, admins: listAdmins(envAdmins, dbAdmins) });
    });

    // Join room
    socket.on(
      "user:join",
      (payload: {
        name: string;
        avatar: any;
        isAdmin?: boolean;
        clientId?: string;
        email?: string;
        sessionToken?: string;
        lastPosition?: { mapId: string; x: number; y: number };
        presenceStatus?: PresenceStatus;
        spaceId?: string;
      }) => {
        // A cross-device stable identity (email) can ONLY come from a verified session token -
        // payload.isAdmin/email are otherwise fully client-controlled and must never be trusted
        // directly (that was previously a trivial privilege-escalation hole: any client could
        // just send { isAdmin: true }). Admin status is then resolved from that verified email
        // against the server's admin list.
        const session = verifySessionToken(payload.sessionToken);

        // Space membership is keyed on the verified email, so a join without a valid token can
        // no longer be treated as a guest. It also means a stale token (expired, or signed with
        // a secret from a previous server boot) is refused rather than silently downgraded -
        // which used to make admin look broken while the client still showed the cached badge.
        if (!session) {
          console.warn(
            `[auth] Missing or stale session token from ${socket.id} - expired, or signed with a ` +
              `previous SESSION_SECRET. Asking the client to sign in again.`,
          );
          socket.emit("auth:expired");
          return;
        }

        if (users.has(socket.id)) return;

        // Which space to enter is the client's request; whether they may is decided here.
        const space = payload.spaceId ? spaces.get(payload.spaceId) : undefined;
        const map = space ? maps.get(space.activeMapId) : undefined;
        if (
          !space ||
          !map ||
          !canEnterSpace(space, { email: session.email, isAdmin: isAdmin(session.email) })
        ) {
          socket.emit("space:denied", { spaceId: payload.spaceId ?? null });
          return;
        }

        // Resume where the browser last left off, as long as it was on this same map and the
        // tile is still walkable (map layout may have changed via the builder since then).
        const lp = payload.lastPosition;
        const preferredPosition =
          lp && lp.mapId === map.id && isTileWalkable(map, lp.x, lp.y)
            ? { x: lp.x, y: lp.y }
            : { ...map.spawnPoint };
        // Collision detection means two users can no longer share a tile - if the resume/spawn
        // tile is already taken, nudge the new arrival to the nearest free tile instead.
        const startPosition = findFreeSpawnTile(
          map,
          preferredPosition,
          socket.id,
        );

        const initialZone = privateZoneIdAt(
          map,
          startPosition.x,
          startPosition.y,
        );

        const admin = isAdmin(session.email);
        const email = session.email || undefined;
        const displayName =
          session.name || payload.name || `Guest_${socket.id.substring(0, 4)}`;

        // Prefer a stable identity that survives reloads/reconnects (socket.id is re-generated
        // every connection) - the verified email when authenticated, else the persisted
        // per-browser clientId, else fall back to socket.id for older/guest clients.
        const stableId = email || payload.clientId || socket.id;

        const validPresenceStatuses: PresenceStatus[] = [
          "available",
          "busy",
          "dnd",
        ];
        const presenceStatus = validPresenceStatuses.includes(
          payload.presenceStatus as PresenceStatus,
        )
          ? (payload.presenceStatus as PresenceStatus)
          : "available";

        const newUser: User = {
          id: stableId,
          socketId: socket.id,
          name: displayName,
          position: startPosition,
          direction: "down",
          avatar: payload.avatar || {
            skinColor: "#f87171",
            hairStyle: "short",
            hairColor: "#1e293b",
            outfitColor: "#3b82f6",
            glasses: false,
            hatStyle: "none",
            statusEmoji: "👋",
          },
          isMuted: false,
          isDeafened: false,
          isSpeaking: false,
          isScreenSharing: false,
          isAdmin: admin,
          currentZoneId: initialZone,
          lastSeen: Date.now(),
          presenceStatus,
          spaceId: space.id,
          mapId: map.id,
          kart: null,
        };

        users.set(socket.id, newUser);
        if (session.email) {
          socketEmails.set(socket.id, session.email.trim().toLowerCase());
        }
        socket.join(room(space.id));
        socket.join(mapRoom(map.id));

        // Send initial map & user state to connected user
        const inSpace = usersIn(space.id);
        const visibleUsers = newUser.isAdmin
          ? inSpace
          : inSpace.filter((u) => !u.isDummy);
        socket.emit("init:state", {
          currentUser: newUser,
          currentMap: map,
          users: visibleUsers,
          space: { id: space.id, name: space.name },
        });

        // Notify others in the same space
        socket.to(room(space.id)).emit("user:joined", newUser);
      },
    );

    // Handle User Movement
    socket.on(
      "user:move",
      (data: {
        x: number;
        y: number;
        direction: "up" | "down" | "left" | "right";
        ghost?: boolean;
        /** Kart heading in radians; only read while driving. */
        heading?: number;
        boost?: boolean;
      }) => {
        const user = users.get(socket.id);
        if (!user) return;

        const map = userMap(socket.id);
        if (!map) return;

        const validDirections = ["up", "down", "left", "right"];
        if (!validDirections.includes(data.direction)) return;
        if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;

        // A kart only survives on a map that allows karts; anywhere else the user walks again.
        if (user.kart && !map.allowKarts) user.kart = null;

        // Driving: the heading is taken even when the move is rejected, so a kart can turn
        // against a wall.
        const headingBefore = user.kart?.heading;
        const boostBefore = user.kart?.boost;
        if (user.kart && Number.isFinite(data.heading)) {
          user.kart.heading = normalizeAngle(data.heading as number);
        }
        if (user.kart) user.kart.boost = data.boost === true;
        const kartFields = () =>
          user.kart ? { heading: user.kart.heading, boost: user.kart.boost === true } : {};

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
          if (
            user.direction === data.direction &&
            user.kart?.heading === headingBefore &&
            user.kart?.boost === boostBefore
          ) {
            return;
          }
          user.direction = data.direction;
          user.lastSeen = Date.now();
          toSpace(socket.id).emit("user:moved", {
            userId: socket.id,
            position: user.position,
            direction: user.direction,
            currentZoneId: user.currentZoneId,
            mapId: user.mapId,
            ...kartFields(),
          });
        };

        if (user.kart) {
          // Driving: float positions are fine. Only the tile they round into is checked, and
          // other users never block a kart.
          if (!validateKartMove(map, data.x, data.y)) return turnInPlace();
        } else {
          // Walking: positions stay on the grid, so a fractional one is refused.
          if (!Number.isInteger(data.x) || !Number.isInteger(data.y)) return turnInPlace();
          if (isTileBlocked(map, data.x, data.y)) return turnInPlace(); // wall, water, object, edge

          // Collision with other users on this map - two people can no longer occupy the same
          // tile, unless the mover is holding Ghost mode (client sends `ghost: true` while "g"
          // is held). Authoritative here (not just client-side) so simultaneous moves from two
          // clients can't both land on the same tile via a race.
          if (
            !data.ghost &&
            isOccupiedByOtherUser(user.mapId, data.x, data.y, socket.id)
          ) {
            return turnInPlace(); // blocked
          }
        }

        // The tile the move lands on, for zones and portals (positions may be fractional).
        const tile = tileAt({ x: data.x, y: data.y });

        // Stepping onto a portal takes the user to its map instead of moving them here. A
        // portal back into the map they are already on is ignored.
        const portal = portalAt(map, tile.x, tile.y);
        if (
          portal &&
          Date.now() - (lastPortalAt.get(socket.id) ?? 0) >= PORTAL_COOLDOWN_MS
        ) {
          const target = resolveTargetMap(user.spaceId, portal.data?.target);
          if (target && target.id !== map.id) {
            enterPortal(user, target);
            return;
          }
        }

        // Update position & zone
        user.position = { x: data.x, y: data.y };
        user.direction = data.direction;
        user.currentZoneId = privateZoneIdAt(map, tile.x, tile.y);
        user.lastSeen = Date.now();

        // Broadcast move to all users in the space (clients filter by mapId)
        toSpace(socket.id).emit("user:moved", {
          userId: socket.id,
          position: user.position,
          direction: user.direction,
          currentZoneId: user.currentZoneId,
          mapId: user.mapId,
          ...kartFields(),
        });
      },
    );

    // The `model` field of a kart event's payload (the first non-function argument), if sent.
    const kartModelArg = (args: unknown[]): unknown =>
      (args.find((a) => a !== null && typeof a === "object") as { model?: unknown } | undefined)?.model;

    // Gets into or out of a kart. Mounting takes the facing as the heading. Dismounting steps the
    // user onto the nearest free walkable integer tile (not a portal, not a walking user's tile),
    // facing the kart's heading. Replies through its ack with { ok, error? }.
    // The `model` in the payload picks the car on mount; unknown or missing ids use the default.
    socket.on("kart:toggle", (...args: unknown[]) => {
      const reply = ackOf(args);
      const user = users.get(socket.id);
      const map = userMap(socket.id);
      if (!user || !map) return reply({ ok: false, error: "Join a space first." });

      if (!user.kart) {
        if (!map.allowKarts) {
          return reply({ ok: false, error: "Karts are only allowed on the race track." });
        }
        const model = kartModelArg(args);
        user.kart = {
          heading: headingFromDirection(user.direction),
          model: isKartModel(model) ? model : DEFAULT_KART_MODEL,
        };
      } else {
        const spot = findFreeTileNear(map, tileAt(user.position), {
          maxRadius: 10,
          isTaken: (x, y) => isOccupiedByOtherUser(map.id, x, y, socket.id, false, true),
        });
        if (!spot) return reply({ ok: false, error: "No free tile to step out onto." });
        user.position = { x: spot.x, y: spot.y };
        user.direction = directionFromHeading(user.kart.heading);
        user.kart = null;
        user.currentZoneId = privateZoneIdAt(map, spot.x, spot.y);
      }

      user.lastSeen = Date.now();
      toSpace(socket.id).emit("user:updated", user);
      reply({ ok: true });
    });

    // Picks the car. While driving the kart switches to it and the space is told; otherwise the
    // client remembers the choice and sends it with its next kart:toggle.
    socket.on("kart:select", (...args: unknown[]) => {
      const reply = ackOf(args);
      const user = users.get(socket.id);
      const map = userMap(socket.id);
      if (!user || !map) return reply({ ok: false, error: "Join a space first." });

      const model = kartModelArg(args);
      if (!isKartModel(model)) return reply({ ok: false, error: "Unknown car." });

      if (user.kart) {
        user.kart.model = model;
        user.lastSeen = Date.now();
        toSpace(socket.id).emit("user:updated", user);
      }
      reply({ ok: true });
    });

    // Takes a user through a portal to `target`: onto a free tile near that map's spawn, into its
    // map room, with any kart cleared. The arrival is a user:updated for the space (not a move),
    // and the user's own socket gets map:entered with the map to render.
    function enterPortal(user: User, target: GridMap) {
      const spot =
        findFreeTileNear(target, target.spawnPoint, {
          maxRadius: 10,
          isTaken: (x, y) => isOccupiedByOtherUser(target.id, x, y, user.socketId),
        }) ?? { ...target.spawnPoint };

      moveUserToMap(user, target.id);
      user.position = { x: spot.x, y: spot.y };
      user.direction = "down";
      user.currentZoneId = privateZoneIdAt(target, spot.x, spot.y);
      user.lastSeen = Date.now();
      lastPortalAt.set(user.socketId, Date.now());

      socket.emit("map:entered", { currentMap: target, user });
      toSpace(socket.id).emit("user:updated", user);
    }

    // Handle User Profile / Status Update
    socket.on("user:update_profile", (updates: Partial<User>) => {
      const user = users.get(socket.id);
      if (!user) return;

      if (updates.name) user.name = updates.name;
      if (updates.avatar) user.avatar = { ...user.avatar, ...updates.avatar };
      if (typeof updates.isMuted === "boolean") user.isMuted = updates.isMuted;
      if (typeof updates.isDeafened === "boolean")
        user.isDeafened = updates.isDeafened;
      if (typeof updates.isSpeaking === "boolean")
        user.isSpeaking = updates.isSpeaking;
      if (typeof updates.isVideoOn === "boolean")
        user.isVideoOn = updates.isVideoOn;
      // Admin status comes from the server's admin list. A client may only switch its own admin
      // flag, and only when its verified email is an admin; it can never grant itself admin.
      if (
        typeof updates.isAdmin === "boolean" &&
        isAdmin(socketEmails.get(socket.id))
      )
        user.isAdmin = updates.isAdmin;
      if (
        updates.presenceStatus &&
        ["available", "busy", "dnd"].includes(updates.presenceStatus)
      ) {
        user.presenceStatus = updates.presenceStatus;
      }

      toSpace(socket.id).emit("user:updated", user);
    });

    // Proximity media runs peer to peer over iroh; the server only publishes each client's
    // endpoint id so others can dial it. The announce is signed by that endpoint's key over
    // this socket's id, which every receiving client verifies, so nobody can pass off someone
    // else's endpoint as theirs. Here we only check its shape and keep ids unique.
    socket.on("media:announce", (data: unknown) => {
      const user = users.get(socket.id);
      if (!user || !validAnnounce(data)) return;
      const taken = [...users.values()].some(
        (u) => u.socketId !== socket.id && u.media?.endpointId === data.endpointId,
      );
      if (taken) return;
      user.media = { endpointId: data.endpointId, relay: data.relay, sig: data.sig };
      relayAccess.register(socket.id, data.endpointId);
      toSpace(socket.id).emit("user:updated", user);
    });

    // The client registers its endpoint id as soon as the endpoint is spawned, before it waits
    // for the relay: a locked relay admits only ids this server knows, so the announce (which
    // comes after online()) would be too late. Only joined users (signed in) may register.
    socket.on("media:register", (data: unknown) => {
      if (!users.has(socket.id)) return;
      const endpointId = (data as { endpointId?: unknown } | null)?.endpointId;
      if (typeof endpointId !== "string") return;
      relayAccess.register(socket.id, endpointId.toLowerCase());
    });

    // Handle Spatial / Room Chat
    socket.on("chat:send", (payload: { text: string; isSpatial: boolean }) => {
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
        // Send to users within 8 tiles, on the same map
        const PROXIMITY_CHAT_RADIUS = 8;
        usersIn(user.spaceId).forEach((otherUser) => {
          if (otherUser.mapId !== user.mapId) return;
          const dist = Math.hypot(
            user.position.x - otherUser.position.x,
            user.position.y - otherUser.position.y,
          );
          if (
            dist <= PROXIMITY_CHAT_RADIUS ||
            user.socketId === otherUser.socketId
          ) {
            io.to(otherUser.socketId).emit("chat:message", chatMsg);
          }
        });
      } else {
        // Broadcast global room message
        toSpace(socket.id).emit("chat:message", chatMsg);
      }
    });

    // Chime: ring a colleague's client to get their attention (particularly meant for
    // reaching someone marked Busy/DND, but works on anyone).
    socket.on(
      "user:chime",
      (
        payload: { to: string },
        ack?: (r: { ok: boolean; reason?: string; name?: string }) => void,
      ) => {
        // Acknowledged so the sender learns what happened. Ringing someone is a request for
        // their attention, and every outcome here used to be a silent `return` - so a
        // rate-limited ring and a delivered one looked identical from the sending side.
        const reply = (ok: boolean, reason?: string, name?: string) => {
          if (typeof ack === "function") ack({ ok, reason, name });
        };

        const sender = users.get(socket.id);
        const target = users.get(payload?.to);
        if (!sender) return reply(false, "not_joined");
        if (
          !target ||
          target.socketId === sender.socketId ||
          target.spaceId !== sender.spaceId
        )
          return reply(false, "gone");
        // Dummies are invisible and cannot be interacted with by normal users
        if (target.isDummy && !sender.isAdmin) return reply(false, "gone");
        if (!sender.isAdmin && target.isDummy) return reply(false, "gone");

        const key = `${sender.socketId}->${target.socketId}`;
        const now = Date.now();
        const last = lastChimeAt.get(key) || 0;
        if (now - last < CHIME_COOLDOWN_MS) {
          return reply(false, "rate_limited", target.name);
        }
        lastChimeAt.set(key, now);

        io.to(target.socketId).emit("chime:received", {
          fromSocketId: sender.socketId,
          fromName: sender.name,
        });
        reply(true, undefined, target.name);
      },
    );

    // Interactive Object: Whiteboard stroke
    socket.on(
      "object:whiteboard_stroke",
      (payload: { objectId: string; stroke: WhiteboardStroke }) => {
        const map = userMap(socket.id);
        if (!map) return;

        const obj = map.objects.find((o) => o.id === payload.objectId);
        if (obj && obj.type === "whiteboard") {
          if (!obj.data) obj.data = {};
          if (!obj.data.whiteboardStrokes) obj.data.whiteboardStrokes = [];
          obj.data.whiteboardStrokes.push(payload.stroke);

          toMap(map.id).emit("object:whiteboard_updated", {
            objectId: payload.objectId,
            strokes: obj.data.whiteboardStrokes,
          });

          persistMap(map);
        }
      },
    );

    // Clear Whiteboard
    socket.on("object:whiteboard_clear", (payload: { objectId: string }) => {
      const map = userMap(socket.id);
      if (!map) return;

      const obj = map.objects.find((o) => o.id === payload.objectId);
      if (obj && obj.type === "whiteboard") {
        if (obj.data) obj.data.whiteboardStrokes = [];
        toMap(map.id).emit("object:whiteboard_updated", {
          objectId: payload.objectId,
          strokes: [],
        });

        persistMap(map);
      }
    });

    // Sticky Note Add
    socket.on(
      "object:add_note",
      (payload: { objectId: string; note: StickyNote }) => {
        const map = userMap(socket.id);
        if (!map) return;

        const author = users.get(socket.id);
        if (!author || !payload?.note) return;

        const obj = map.objects.find((o) => o.id === payload.objectId);
        if (!obj) return;

        // Authorship is stamped from the connection, not taken from the payload: a client
        // could otherwise post under someone else's name, and authorId is what deletion is
        // authorised against, so it has to mean something.
        const note: StickyNote = {
          id:
            typeof payload.note.id === "string"
              ? payload.note.id
              : `note_${Date.now()}`,
          text: String(payload.note.text ?? "").slice(0, 500),
          color:
            typeof payload.note.color === "string"
              ? payload.note.color
              : "#fef08a",
          createdAt: Date.now(),
          author: author.name,
          authorId: author.id,
        };
        if (!note.text.trim()) return;

        if (obj.type === "sticky_notes") {
          if (!obj.data) obj.data = {};
          if (!obj.data.notes) obj.data.notes = [];
          obj.data.notes.push(note);

          toMap(map.id).emit("object:notes_updated", {
            objectId: payload.objectId,
            notes: obj.data.notes,
          });

          persistMap(map);
          return;
        }

        // Desk notes go through this path too, so that leaving a note is the *only* way to
        // change someone else's desk - it can append, and nothing else.
        if (obj.type === "desk" || obj.type === "computer") {
          obj.data = obj.data || {};
          const state = obj.data.deskState || {};
          obj.data.deskState = {
            ...state,
            stickyNotes: [note, ...(state.stickyNotes || [])],
          };

          toMap(map.id).emit("map:object_updated", {
            objectId: payload.objectId,
            object: obj,
          });
          persistMap(map);
        }
      },
    );

    // Game move
    socket.on(
      "object:game_move",
      (payload: { objectId: string; index: number; symbol: "X" | "O" }) => {
        const map = userMap(socket.id);
        if (!map) return;

        const obj = map.objects.find((o) => o.id === payload.objectId);
        if (!obj || obj.type !== "game_table" || !obj.data?.gameState) return;

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
        state.turn = payload.symbol === "X" ? "O" : "X";
        state.winner = findWinner(state.board, specFor(state.game));

        toMap(map.id).emit("object:game_updated", {
          objectId: payload.objectId,
          gameState: state,
        });

        persistMap(map);
      },
    );

    // Reset Game (also how the table is switched between games)
    socket.on(
      "object:game_reset",
      (payload: { objectId: string; game?: GameTableGame }) => {
        const map = userMap(socket.id);
        if (!map) return;

        const obj = map.objects.find((o) => o.id === payload.objectId);
        if (!obj || obj.type !== "game_table" || !obj.data?.gameState) return;

        const current = normalizeGameState(obj.data.gameState);
        const nextGame =
          payload.game && GAME_SPECS[payload.game]
            ? payload.game
            : current.game;
        obj.data.gameState = createGameState(nextGame);

        toMap(map.id).emit("object:game_updated", {
          objectId: payload.objectId,
          gameState: obj.data.gameState,
        });

        persistMap(map);
      },
    );

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
      "object:delete_note",
      (
        payload: { objectId: string; noteId: string },
        ack?: (r: { ok: boolean; reason?: string }) => void,
      ) => {
        // Acknowledged so a refused or unhandled delete is visible. Every failure path here is
        // a silent `return`, which is what made a stale server (one started before this handler
        // existed) look identical to a working one that simply declined.
        const reply = (ok: boolean, reason?: string) => {
          if (typeof ack === "function") ack({ ok, reason });
        };

        const map = userMap(socket.id);
        if (!map) return reply(false, "no_map");

        const user = users.get(socket.id);
        if (!user || !payload?.objectId || !payload?.noteId)
          return reply(false, "bad_request");

        const obj = map.objects.find((o) => o.id === payload.objectId);
        if (!obj) return reply(false, "no_object");

        if (obj.type === "sticky_notes") {
          const notes = obj.data?.notes;
          const note = notes?.find((n) => n.id === payload.noteId);
          if (!notes || !note) return reply(false, "no_note");
          if (!canDeleteNote(user, note)) return reply(false, "not_allowed");

          obj.data!.notes = notes.filter((n) => n.id !== payload.noteId);
          toMap(map.id).emit("object:notes_updated", {
            objectId: payload.objectId,
            notes: obj.data!.notes,
          });
          persistMap(map);
          return reply(true);
        }

        if (obj.type === "desk" || obj.type === "computer") {
          const deskState = obj.data?.deskState;
          const notes = deskState?.stickyNotes;
          const note = notes?.find((n) => n.id === payload.noteId);
          if (!deskState || !notes || !note) return reply(false, "no_note");
          if (!canDeleteNote(user, note, deskState))
            return reply(false, "not_allowed");

          deskState.stickyNotes = notes.filter((n) => n.id !== payload.noteId);
          toMap(map.id).emit("map:object_updated", {
            objectId: payload.objectId,
            object: obj,
          });
          persistMap(map);
          return reply(true);
        }

        return reply(false, "unsupported_object");
      },
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
      const map = userMap(socket.id);
      if (!map) return null;
      const obj = map.objects.find((o) => o.id === objectId);
      return obj && (obj.type === "desk" || obj.type === "computer")
        ? obj
        : null;
    }

    function broadcastDesk(desk: MapObject) {
      const map = userMap(socket.id);
      if (map) toMap(map.id).emit("map:object_updated", { objectId: desk.id, object: desk });
      persistMap(map);
    }

    socket.on("object:desk_claim", (payload: { objectId: string }) => {
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
        statusNote: state.statusNote || "💻 Working at my desk",
      };
      broadcastDesk(desk);
    });

    socket.on("object:desk_release", (payload: { objectId: string }) => {
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
        statusNote: "",
      };
      broadcastDesk(desk);
    });

    socket.on(
      "object:desk_settings",
      (payload: {
        objectId: string;
        statusNote?: string;
        equipment?: string;
      }) => {
        const user = users.get(socket.id);
        const desk = payload?.objectId ? findDesk(payload.objectId) : null;
        if (!user || !desk) return;

        const state = desk.data?.deskState;
        if (!canManageDesk(user, state)) return;

        desk.data!.deskState = {
          ...state,
          statusNote:
            typeof payload.statusNote === "string"
              ? payload.statusNote.slice(0, 140)
              : state!.statusNote,
          equipment: isDeskEquipment(payload.equipment)
            ? payload.equipment
            : state!.equipment,
        };
        broadcastDesk(desk);
      },
    );

    // Map Builder - Add or Update Private Zone
    socket.on("map:add_zone", (zone: PrivateZone) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = userMap(socket.id);
      if (!map) return;

      const existingIndex = map.privateZones.findIndex((z) => z.id === zone.id);
      if (existingIndex >= 0) {
        map.privateZones[existingIndex] = zone;
      } else {
        map.privateZones.push(zone);
      }

      // Recalculate zone for everyone on this map
      usersOn(map.id).forEach((u) => {
        u.currentZoneId = privateZoneIdAt(map, u.position.x, u.position.y);
      });

      broadcastUsersWithFilter(sender.spaceId, "map:zones_updated", (userList) => ({
        privateZones: map.privateZones,
        users: userList,
      }), map.id);

      persistMap(map);
    });

    // Map Builder - Remove Private Zone
    socket.on("map:remove_zone", (zoneId: string) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = userMap(socket.id);
      if (!map) return;

      map.privateZones = map.privateZones.filter((z) => z.id !== zoneId);

      // Recalculate zone for everyone on this map
      usersOn(map.id).forEach((u) => {
        u.currentZoneId = privateZoneIdAt(map, u.position.x, u.position.y);
      });

      broadcastUsersWithFilter(spaceIdOf(socket.id), "map:zones_updated", (userList) => ({
        privateZones: map.privateZones,
        users: userList,
      }), map.id);

      persistMap(map);
    });

    // Map Builder - Add or Place Object
    socket.on("map:place_object", (newObj: MapObject) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = userMap(socket.id);
      if (!map) return;

      map.objects.push(newObj);
      toMap(map.id).emit("map:object_placed", newObj);
      persistMap(map);
    });

    // Map Builder - Move Object
    socket.on(
      "map:move_object",
      (payload: { objectId: string; x: number; y: number }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;
        const map = userMap(socket.id);
        if (!map) return;

        const obj = map.objects.find((o) => o.id === payload.objectId);
        if (obj) {
          obj.x = payload.x;
          obj.y = payload.y;
          toMap(map.id).emit("map:object_updated", {
            objectId: payload.objectId,
            object: obj,
          });
          persistMap(map);
        }
      },
    );

    // Map Builder - Remove Object
    socket.on("map:remove_object", (objectId: string) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const map = userMap(socket.id);
      if (!map) return;

      map.objects = map.objects.filter((o) => o.id !== objectId);
      toMap(map.id).emit("map:object_removed", objectId);
      persistMap(map);
    });

    // Map Builder - Change Tile
    socket.on(
      "map:change_tile",
      (payload: { x: number; y: number; tileType: any }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;
        const map = userMap(socket.id);
        if (!map) return;

        if (
          payload.y >= 0 &&
          payload.y < map.height &&
          payload.x >= 0 &&
          payload.x < map.width
        ) {
          map.tiles[payload.y][payload.x] = payload.tileType;
          toMap(map.id).emit("map:tile_changed", payload);
          persistMap(map);
        }
      },
    );

    // Switch Map Preset
    socket.on("map:switch_preset", (mapId: string) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;
      const space = sender.spaceId ? spaces.get(sender.spaceId) : undefined;
      // Only maps that belong to the admin's own space can be switched to. The client asks for
      // a preset by its base id ("beach_retreat"); a space created after spaces existed owns
      // namespaced copies of it ("<spaceId>:beach_retreat"). See resolveSpaceMapId.
      const targetId = space
        ? resolveSpaceMapId(space.id, mapId, (id) => maps.get(id))
        : null;
      if (space && targetId) {
        space.activeMapId = targetId;
        const newMap = maps.get(targetId)!;
        db.saveSpace(space);

        // Teleport everyone in this space to spawn, onto the new map
        usersIn(space.id).forEach((u) => {
          u.position = { ...newMap.spawnPoint };
          u.currentZoneId = privateZoneIdAt(
            newMap,
            u.position.x,
            u.position.y,
          );
          moveUserToMap(u, newMap.id);
        });

        broadcastUsersWithFilter(spaceIdOf(socket.id), "map:switched", (userList) => ({
          currentMap: newMap,
          users: userList,
        }));
      }
    });

    // Handle Disconnect
    socket.on("disconnect", () => {
      console.log(`User disconnected: ${socket.id}`);
      const leftSpaceId = spaceIdOf(socket.id);
      users.delete(socket.id);
      socketEmails.delete(socket.id);
      lastPortalAt.delete(socket.id);
      relayAccess.unregister(socket.id);
      if (leftSpaceId) {
        io.to(room(leftSpaceId)).emit("user:left", socket.id);
      }

      // Drop any chime cooldown entries involving this socket so the map doesn't grow forever.
      for (const key of lastChimeAt.keys()) {
        if (
          key.startsWith(`${socket.id}->`) ||
          key.endsWith(`->${socket.id}`)
        ) {
          lastChimeAt.delete(key);
        }
      }
    });

    // ==========================================
    // DUMMY USERS (Admin Only - Hidden from Normal Users)
    // ==========================================

    // Admin places a new dummy user
    socket.on(
      "dummy:place",
      (payload: {
        name?: string;
        x: number;
        y: number;
        direction?: Direction;
        presenceStatus?: PresenceStatus;
      }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const map = userMap(socket.id);
        if (!map) return;

        const dummyId = `dummy_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        const dummyUser: User = {
          id: dummyId,
          socketId: dummyId,
          name:
            payload.name ||
            `Dummy_${Math.random().toString(36).substring(2, 6)}`,
          position: { x: payload.x, y: payload.y },
          direction: payload.direction || "down",
          avatar: {
            skinColor: "#a78bfa",
            hairStyle: "short",
            hairColor: "#1e293b",
            outfitColor: "#8b5cf6",
            glasses: false,
            hatStyle: "none",
            statusEmoji: "🤖",
          },
          isMuted: false,
          isDeafened: false,
          // Dummies emit a continuous synthetic audio/video signal on the admin's client,
          // so they should read as permanently speaking.
          isSpeaking: true,
          isScreenSharing: false,
          isAdmin: true,
          isDummy: true,
          currentZoneId: privateZoneIdAt(map, payload.x, payload.y),
          lastSeen: Date.now(),
          presenceStatus: payload.presenceStatus || "available",
        };

        dummyUser.spaceId = sender.spaceId;
        dummyUser.mapId = map.id;
        users.set(dummyId, dummyUser);
        emitToAdmins(spaceIdOf(socket.id), "user:joined", dummyUser);
      },
    );

    // Admin moves a dummy user
    socket.on(
      "dummy:move",
      (payload: {
        dummyId: string;
        x: number;
        y: number;
        direction?: Direction;
      }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const dummy = users.get(payload?.dummyId);
        if (!dummy || !dummy.isDummy || dummy.spaceId !== sender.spaceId) return;

        // The dummy is on its own map, which is not necessarily the admin's.
        const map = mapOfUser(dummy);
        if (!map) return;

        dummy.position = { x: payload.x, y: payload.y };
        if (payload.direction) dummy.direction = payload.direction;
        dummy.currentZoneId = privateZoneIdAt(map, payload.x, payload.y);

        emitToAdmins(spaceIdOf(socket.id), "user:moved", {
          userId: dummy.socketId,
          position: dummy.position,
          direction: dummy.direction,
          currentZoneId: dummy.currentZoneId,
          mapId: dummy.mapId,
        });
      },
    );

    // Admin updates a dummy user (name, status, voice/speaking, mute, etc.)
    socket.on(
      "dummy:update",
      (payload: { dummyId: string; updates: Partial<User> }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const dummy = users.get(payload?.dummyId);
        if (!dummy || !dummy.isDummy || dummy.spaceId !== sender.spaceId) return;

        const { updates } = payload;
        if (!updates) return;

        if (typeof updates.name === "string" && updates.name.trim()) {
          dummy.name = updates.name.trim();
        }
        if (updates.avatar) {
          dummy.avatar = { ...dummy.avatar, ...updates.avatar };
        }
        if (
          updates.presenceStatus &&
          ["available", "busy", "dnd"].includes(updates.presenceStatus)
        ) {
          dummy.presenceStatus = updates.presenceStatus;
        }
        if (typeof updates.isSpeaking === "boolean") {
          dummy.isSpeaking = updates.isSpeaking;
        }
        if (typeof updates.isMuted === "boolean") {
          dummy.isMuted = updates.isMuted;
        }
        if (
          updates.direction &&
          ["up", "down", "left", "right"].includes(updates.direction)
        ) {
          dummy.direction = updates.direction;
        }

        emitToAdmins(spaceIdOf(socket.id), "user:updated", dummy);
      },
    );

    // Admin removes a dummy user
    socket.on("dummy:remove", (payload: { dummyId: string }) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;

      const dummy = users.get(payload?.dummyId);
      if (!dummy || !dummy.isDummy || dummy.spaceId !== sender.spaceId) return;

      users.delete(payload.dummyId);
      emitToAdmins(spaceIdOf(socket.id), "user:left", payload.dummyId);
    });

    // Admin triggers dummy to say something in chat (only visible to admins!)
    socket.on(
      "dummy:chat",
      (payload: { dummyId: string; text: string; isSpatial: boolean }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const dummy = users.get(payload?.dummyId);
        if (!dummy || !dummy.isDummy || dummy.spaceId !== sender.spaceId) return;
        if (!payload.text?.trim()) return;

        const chatMsg: ChatMessage = {
          id: `msg_${Date.now()}`,
          senderId: dummy.socketId,
          senderName: dummy.name,
          text: payload.text.trim(),
          timestamp: Date.now(),
          isSpatial: Boolean(payload.isSpatial),
          senderPosition: { ...dummy.position },
        };

        if (payload.isSpatial) {
          const PROXIMITY_CHAT_RADIUS = 8;
          for (const otherUser of usersIn(dummy.spaceId)) {
            if (!otherUser.isAdmin || otherUser.isDummy) continue;
            if (otherUser.mapId !== dummy.mapId) continue;
            const dist = Math.hypot(
              dummy.position.x - otherUser.position.x,
              dummy.position.y - otherUser.position.y,
            );
            if (dist <= PROXIMITY_CHAT_RADIUS) {
              io.to(otherUser.socketId).emit("chat:message", chatMsg);
            }
          }
        } else {
          for (const otherUser of usersIn(dummy.spaceId)) {
            if (otherUser.isAdmin && !otherUser.isDummy) {
              io.to(otherUser.socketId).emit("chat:message", chatMsg);
            }
          }
        }
      },
    );
  });

  // REST API Endpoints with Hono
  app.get("/api/health", (c) => {
    return c.json({ status: "ok", activeUsers: users.size });
  });

  // Relay list for proximity audio/video, read once at startup from IROH_RELAYS. Public like
  // /api/health: relay URLs aren't secret, and the client only asks after joining.
  const mediaRelays = parseRelayList(process.env.IROH_RELAYS);
  app.get("/api/media-config", (c) => {
    return c.json({ relays: mediaRelays });
  });

  // Access hook for the self-hosted iroh relay (HTTP access mode). The relay POSTs here, with
  // no body, once per incoming connection, and admits the endpoint only on a 200 "true".
  // Off unless RELAY_ACCESS_TOKEN is set; the relay must send the same token as a Bearer.
  const relayAccessToken = process.env.RELAY_ACCESS_TOKEN ?? "";
  app.post("/internal/relay-access", (c) => {
    if (!relayAccessToken) return c.text("Not found", 404);
    if (!checkBearer(c.req.header("Authorization"), relayAccessToken)) {
      return c.text("Unauthorized", 401);
    }
    const nodeId = (c.req.header("X-Iroh-NodeId") ?? "").toLowerCase();
    const allowed = isEndpointIdHex(nodeId) && relayAccess.allows(nodeId);
    console.log(`[relay-access] ${allowed ? "allow" : "deny"} ${nodeId.slice(0, 8)}`);
    return c.text(allowed ? "true" : "false", 200);
  });

  app.get("/api/workspace/sqlite-info", (c) => {
    return c.json({
      status: "ok",
      sqlite: db.getDbInfo(),
      spaces: [...spaces.values()].map((sp) => ({
        id: sp.id,
        activeMapId: sp.activeMapId,
      })),
    });
  });

  // Google sign-in (OpenID Connect, authorization code flow with PKCE). GOOGLE_CLIENT_ID and
  // GOOGLE_CLIENT_SECRET come from the Google Cloud OAuth client. PUBLIC_URL, when set, is the
  // origin users reach the app on (trailing slash stripped); otherwise it is derived per request.
  const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const googleConfigured = !!googleClientId && !!googleClientSecret;
  if (!googleConfigured) {
    console.warn(
      "[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set - Google sign-in is disabled.",
    );
  }
  const publicUrlEnv = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  let publicOriginEnv = "";
  if (publicUrlEnv) {
    try {
      publicOriginEnv = new URL(publicUrlEnv).origin;
    } catch {
      console.warn(`[auth] PUBLIC_URL is not a valid URL - ignoring it.`);
    }
  }

  // The origin the browser uses for the app. Used for the redirect URI and as the only
  // postMessage target origin. Query parameters from the client are never consulted.
  function publicOrigin(c: Context): string {
    if (publicOriginEnv) return publicOriginEnv;
    const reqUrl = new URL(c.req.url);
    const rawProto =
      c.req.header("x-forwarded-proto") ||
      reqUrl.protocol.replace(":", "") ||
      "https";
    const proto = rawProto.split(",")[0].trim();
    const rawHost =
      c.req.header("x-forwarded-host") ||
      c.req.header("host") ||
      reqUrl.host ||
      "";
    const host = rawHost.split(",")[0].trim();
    const finalProto =
      host.endsWith(".run.app") || proto === "https" ? "https" : proto;
    return `${finalProto}://${host}`;
  }

  const escapeHtml = (text: string): string =>
    text.replace(
      /[&<>"']/g,
      (ch) =>
        (
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          }) as Record<string, string>
        )[ch],
    );

  // JSON that is safe to embed inside a <script> element: `<` and the JS line separators are
  // escaped so no value can close the script tag or break out of the literal.
  const scriptJson = (value: unknown): string =>
    JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");

  // Constant-time equality for the OAuth state value.
  function sameValue(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  // Result page for the sign-in popup. Posts the outcome to the opener using the app's own
  // origin, and falls back to a plain redirect (success) or a back link (error) without one.
  function authResultPage(
    origin: string,
    message:
      | { type: "OAUTH_AUTH_SUCCESS"; user: Record<string, unknown> }
      | { type: "OAUTH_AUTH_ERROR"; error: string },
    view: {
      ok: boolean;
      title: string;
      background: string;
      heading: string;
      body: string;
    },
  ): string {
    const closeDelay = view.ok ? 800 : 2000;
    return `
        <!DOCTYPE html>
        <html>
          <head>
            <title>${escapeHtml(view.title)}</title>
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: ${view.background}; color: #0f172a; }
              .card { background: white; border: 3px solid #0f172a; border-radius: 16px; padding: 24px; box-shadow: 6px 6px 0px #0f172a; text-align: center; max-width: 320px; }
              h2 { font-size: 18px; margin-top: 0; ${view.ok ? "" : "color: #dc2626;"} }
              p { font-size: 13px; font-weight: bold; }
              a { color: #0f172a; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>${escapeHtml(view.heading)}</h2>
              <p>${escapeHtml(view.body)}</p>
              ${view.ok ? "" : '<p><a href="/">Back to PeerSpace</a></p>'}
            </div>
            <script>
              const message = ${scriptJson(message)};
              const targetOrigin = ${scriptJson(origin)};
              if (window.opener) {
                try {
                  window.opener.postMessage(message, targetOrigin);
                } catch (e) {
                  console.error('Failed to postMessage to opener:', e);
                }
                setTimeout(() => { window.close(); }, ${closeDelay});
              } else if (message.type === 'OAUTH_AUTH_SUCCESS') {
                window.location.href = '/?auth_user=' + encodeURIComponent(JSON.stringify(message.user));
              }
            </script>
          </body>
        </html>
      `;
  }

  // Login URL endpoint: starts the Google authorization request. The PKCE verifier, state and
  // nonce travel in an encrypted, httpOnly cookie that is only sent to the callback path.
  app.get("/api/auth/login-url", (c) => {
    c.header("Cache-Control", "no-store");
    if (!googleConfigured) {
      return c.json({ error: "Google sign-in is not configured" }, 503);
    }

    const origin = publicOrigin(c);
    const redirectUri = `${origin}/auth/callback`;
    const { verifier, challenge } = createPkce();
    const state = randomToken();
    const nonce = randomToken();

    const sealed = sealLoginState(
      { state, verifier, nonce, createdAt: Date.now() },
      getSessionSecret(),
    );
    setCookie(c, "ps_login", sealed, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/auth/callback",
      maxAge: 600,
      secure: origin.startsWith("https:"),
    });

    const url = buildAuthUrl({
      clientId: googleClientId,
      redirectUri,
      state,
      nonce,
      codeChallenge: challenge,
    });
    return c.json({ url, redirectUri });
  });

  // OAuth callback: verifies the login state, exchanges the code, validates the id_token and
  // issues the server-signed session token that the socket layer trusts.
  app.get("/auth/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    const sealed = getCookie(c, "ps_login");
    deleteCookie(c, "ps_login", { path: "/auth/callback" });
    const origin = publicOrigin(c);

    const failed = (reason: string, error: string) => {
      console.warn(`[auth] Google sign-in failed: ${reason}`);
      return c.html(
        authResultPage(
          origin,
          { type: "OAUTH_AUTH_ERROR", error },
          {
            ok: false,
            title: "Sign-in failed",
            background: "#f87171",
            heading: "⚠️ Sign-in failed",
            body: error,
          },
        ),
        400,
      );
    };

    try {
      if (!googleConfigured) {
        return failed("Google sign-in is not configured", "Google sign-in is not available.");
      }

      const oauthError = c.req.query("error");
      if (oauthError) {
        return failed(
          `provider returned error "${String(oauthError).slice(0, 64)}"`,
          "Sign-in was cancelled.",
        );
      }

      const code = c.req.query("code");
      if (!code) {
        return failed("missing authorization code", "No authorization code was returned.");
      }

      const login = openLoginState(sealed, getSessionSecret());
      if (!login) {
        return failed(
          "login cookie missing, expired or invalid",
          "Your sign-in session expired. Please try again.",
        );
      }

      const state = c.req.query("state") ?? "";
      if (!sameValue(state, login.state)) {
        return failed("state mismatch", "Sign-in could not be verified. Please try again.");
      }

      let idToken: string;
      try {
        ({ idToken } = await exchangeCode({
          code,
          verifier: login.verifier,
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          redirectUri: `${origin}/auth/callback`,
        }));
      } catch (err) {
        return failed(
          `token exchange: ${err instanceof Error ? err.message : "unknown error"}`,
          "Could not complete sign-in with Google.",
        );
      }

      const claims = decodeJwtPayload(idToken);
      if (!claims) {
        return failed("id_token is not a decodable JWT", "Could not read your Google account.");
      }
      const identity = validateIdTokenClaims(claims, {
        clientId: googleClientId,
        nonce: login.nonce,
      });
      if ("error" in identity) {
        return failed(
          `id_token rejected: ${identity.error}`,
          "Your Google account could not be verified.",
        );
      }

      const email = identity.email.trim().toLowerCase();
      const name = identity.name || email.split("@")[0] || email;
      const admin = isAdmin(email);
      const userData = {
        name,
        email,
        isAdmin: admin,
        authenticated: true,
        // Signed by the server after the id_token was verified. The socket layer trusts this
        // token (never raw client-submitted name/email/isAdmin) for identity; admin status is
        // resolved from the email on each use.
        sessionToken: createSessionToken({ email, name, isAdmin: admin }),
      };

      return c.html(
        authResultPage(
          origin,
          { type: "OAUTH_AUTH_SUCCESS", user: userData },
          {
            ok: true,
            title: "Signing in…",
            background: "#fbbf24",
            heading: "🎉 Login successful!",
            body: `Welcome, ${name}! Returning to PeerSpace...`,
          },
        ),
      );
    } catch (err) {
      console.error("Google OAuth callback error:", err);
      return failed("unexpected error", "Something went wrong. Please try again.");
    }
  });

  // Serve static assets in production
  if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), "dist");
    app.use("*", serveStatic({ root: "./dist" }));
    app.get("*", (c) => {
      try {
        const html = fs.readFileSync(
          path.join(distPath, "index.html"),
          "utf-8",
        );
        return c.html(html);
      } catch {
        return c.text("Not found", 404);
      }
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    const scheme = useHttps ? "https" : "http";
    console.log(
      `PeerSpace Hono/Bun server running on ${scheme}://0.0.0.0:${PORT}`,
    );
    if (useHttps) {
      const lanIps = Object.values(os.networkInterfaces())
        .flat()
        .filter(
          (i): i is os.NetworkInterfaceInfo =>
            !!i && i.family === "IPv4" && !i.internal,
        )
        .map((i) => i.address);
      lanIps.forEach((ip) => {
        console.log(
          `  -> Open this URL on your phone (same wifi) to test camera/mic: ${scheme}://${ip}:${PORT}`,
        );
      });
    }
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
