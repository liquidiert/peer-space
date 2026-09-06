import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf-8');

// 1. isOccupiedByOtherUser update
const oldOccupied =   // Helper: is this tile currently stood on by some other connected user?
  function isOccupiedByOtherUser(x: number, y: number, excludeSocketId: string): boolean {
    for (const u of users.values()) {
      if (u.socketId !== excludeSocketId && u.position.x === x && u.position.y === y) {
        return true;
      }
    }
    return false;
  };

const newOccupied =   // Helper: is this tile currently stood on by some other connected user?
  // Normal users do not collide with dummy users (they cannot see them, so they must not hit invisible walls).
  function isOccupiedByOtherUser(x: number, y: number, excludeSocketId: string, forAdmin = false): boolean {
    for (const u of users.values()) {
      if (u.socketId !== excludeSocketId && u.position.x === x && u.position.y === y) {
        if (u.isDummy && !forAdmin) continue;
        return true;
      }
    }
    return false;
  };

if (!code.includes(oldOccupied)) {
  console.error('Could not find oldOccupied');
  process.exit(1);
}
code = code.replace(oldOccupied, newOccupied);

// 2. findFreeSpawnTile update
const oldSpawn =   function findFreeSpawnTile(
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
  };

const newSpawn =   function findFreeSpawnTile(
    map: GridMap,
    preferred: { x: number; y: number },
    excludeSocketId: string,
    forAdmin = false
  ): { x: number; y: number } {
    if (isTileWalkable(map, preferred.x, preferred.y) && !isOccupiedByOtherUser(preferred.x, preferred.y, excludeSocketId, forAdmin)) {
      return preferred;
    }
    for (let radius = 1; radius <= 10; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
          const x = preferred.x + dx;
          const y = preferred.y + dy;
          if (isTileWalkable(map, x, y) && !isOccupiedByOtherUser(x, y, excludeSocketId, forAdmin)) {
            return { x, y };
          }
        }
      }
    }
    return preferred; // give up - overlap is better than an infinite/failed join
  }

  function emitToAdmins(eventName: string, data: any) {
    for (const [sId, u] of users.entries()) {
      if (u.isAdmin && !u.isDummy) {
        io.to(sId).emit(eventName, data);
      }
    }
  }

  function broadcastUsersWithFilter(eventName: string, makePayload: (userList: User[]) => any) {
    const allUsers = Array.from(users.values());
    const publicUsers = allUsers.filter((u) => !u.isDummy);
    for (const [sId, u] of users.entries()) {
      if (u.isDummy) continue;
      io.to(sId).emit(eventName, makePayload(u.isAdmin ? allUsers : publicUsers));
    }
  };

if (!code.includes(oldSpawn)) {
  console.error('Could not find oldSpawn');
  process.exit(1);
}
code = code.replace(oldSpawn, newSpawn);

// 3. updateSpatialProximity update
const oldProx =     userList.forEach((userA) => {
      const activePeers: { peerId: string; distance: number; inSameZone: boolean }[] = [];

      userList.forEach((userB) => {
        if (userA.socketId === userB.socketId) return;

        const zoneA = userA.currentZoneId;
        const zoneB = userB.currentZoneId;;

const newProx =     userList.forEach((userA) => {
      if (userA.isDummy) return;

      const activePeers: { peerId: string; distance: number; inSameZone: boolean }[] = [];

      userList.forEach((userB) => {
        if (userA.socketId === userB.socketId) return;

        // Dummies are completely invisible to non-admins
        if (userB.isDummy && !userA.isAdmin) return;

        const zoneA = userA.currentZoneId;
        const zoneB = userB.currentZoneId;;

if (!code.includes(oldProx)) {
  console.error('Could not find oldProx');
  process.exit(1);
}
code = code.replace(oldProx, newProx);

// 4. user:join update
const oldInitUsers =       // Send initial map & user state to connected user
      socket.emit('init:state', {
        currentUser: newUser,
        currentMap: map,
        users: Array.from(users.values()),
      });;

const newInitUsers =       // Send initial map & user state to connected user (filter out dummies for non-admins)
      const visibleUsers = isAdmin
        ? Array.from(users.values())
        : Array.from(users.values()).filter((u) => !u.isDummy);

      socket.emit('init:state', {
        currentUser: newUser,
        currentMap: map,
        users: visibleUsers,
      });;

if (!code.includes(oldInitUsers)) {
  console.error('Could not find oldInitUsers');
  process.exit(1);
}
code = code.replace(oldInitUsers, newInitUsers);

// 5. user:move collision update
const oldMoveCollision = if (!data.ghost && isOccupiedByOtherUser(data.x, data.y, socket.id)) {;
const newMoveCollision = if (!data.ghost && isOccupiedByOtherUser(data.x, data.y, socket.id, Boolean(user.isAdmin))) {;

if (!code.includes(oldMoveCollision)) {
  console.error('Could not find oldMoveCollision');
  process.exit(1);
}
code = code.replace(oldMoveCollision, newMoveCollision);

// 6. user:chime dummy handling
const oldChimeTargetCheck =         const sender = users.get(socket.id);
        const target = users.get(payload?.to);
        if (!sender) return reply(false, 'not_joined');
        if (!target || target.socketId === sender.socketId) return reply(false, 'gone');;

const newChimeTargetCheck =         const sender = users.get(socket.id);
        const target = users.get(payload?.to);
        if (!sender) return reply(false, 'not_joined');
        if (!target || target.socketId === sender.socketId) return reply(false, 'gone');

        if (target.isDummy) {
          if (!sender.isAdmin) {
            return reply(false, 'gone');
          }
          const key = \\->\\;
          const now = Date.now();
          const last = lastChimeAt.get(key) || 0;
          if (now - last < CHIME_COOLDOWN_MS) {
            return reply(false, 'rate_limited', target.name);
          }
          lastChimeAt.set(key, now);

          reply(true, undefined, target.name);

          // Admin chimed a dummy: simulate dummy visual feedback
          target.avatar = { ...target.avatar, statusEmoji: '🔔' };
          target.isSpeaking = true;
          emitToAdmins('user:updated', target);

          setTimeout(() => {
            const currentDummy = users.get(target.socketId);
            if (currentDummy && currentDummy.isDummy) {
              currentDummy.isSpeaking = false;
              currentDummy.avatar = { ...currentDummy.avatar, statusEmoji: '🤖' };
              emitToAdmins('user:updated', currentDummy);
            }
          }, 2000);
          return;
        };

if (!code.includes(oldChimeTargetCheck)) {
  console.error('Could not find oldChimeTargetCheck');
  process.exit(1);
}
code = code.replace(oldChimeTargetCheck, newChimeTargetCheck);

// 7. map:zones_updated and map:switched updates
code = code.replaceAll(      io.emit('map:zones_updated', {
        privateZones: map.privateZones,
        users: Array.from(users.values()),
      });,       broadcastUsersWithFilter('map:zones_updated', (userList) => ({
        privateZones: map.privateZones,
        users: userList,
      })););

code = code.replace(        io.emit('map:switched', {
          currentMap: newMap,
          users: Array.from(users.values()),
        });,         broadcastUsersWithFilter('map:switched', (userList) => ({
          currentMap: newMap,
          users: userList,
        })););

// 8. Add dummy handlers before disconnect
const disconnectAnchor =     // Handle Disconnect
    socket.on('disconnect', () => {;

const dummyHandlers =     // ==========================================
    // DUMMY USERS (Admin Only - Hidden from Normal Users)
    // ==========================================

    // Admin places a new dummy user
    socket.on(
      'dummy:place',
      (payload: {
        name?: string;
        position: { x: number; y: number };
        direction?: Direction;
        avatar?: AvatarCustomization;
        presenceStatus?: PresenceStatus;
      }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const map = maps.get(currentMapId) || defaultOffice;
        const x = Math.max(0, Math.min(map.width - 1, Math.round(payload.position?.x ?? map.spawnPoint.x)));
        const y = Math.max(0, Math.min(map.height - 1, Math.round(payload.position?.y ?? map.spawnPoint.y)));

        const dummyId = \dummy_\_\\;
        const dummyUser: User = {
          id: dummyId,
          socketId: dummyId,
          name: payload.name?.trim() || \Dummy Bot\,
          position: { x, y },
          direction: payload.direction || 'down',
          avatar: payload.avatar || {
            skinColor: '#38bdf8',
            hairStyle: 'messy',
            hairColor: '#f59e0b',
            outfitColor: '#6366f1',
            glasses: true,
            hatStyle: 'cap',
            statusEmoji: '🤖',
          },
          isMuted: false,
          isDeafened: false,
          isSpeaking: false,
          isScreenSharing: false,
          isAdmin: false,
          currentZoneId: getPrivateZoneId(map, x, y),
          lastSeen: Date.now(),
          presenceStatus: payload.presenceStatus || 'available',
          isDummy: true,
        };

        users.set(dummyId, dummyUser);
        emitToAdmins('user:joined', dummyUser);
        updateSpatialProximity();
      }
    );

    // Admin moves a dummy user
    socket.on(
      'dummy:move',
      (payload: { dummyId: string; x: number; y: number; direction?: Direction }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const dummy = users.get(payload?.dummyId);
        if (!dummy || !dummy.isDummy) return;

        const map = maps.get(currentMapId);
        if (!map) return;

        const x = Math.max(0, Math.min(map.width - 1, Math.round(payload.x)));
        const y = Math.max(0, Math.min(map.height - 1, Math.round(payload.y)));

        dummy.position = { x, y };
        if (payload.direction) dummy.direction = payload.direction;
        dummy.currentZoneId = getPrivateZoneId(map, x, y);

        emitToAdmins('user:moved', {
          userId: dummy.socketId,
          position: dummy.position,
          direction: dummy.direction,
          currentZoneId: dummy.currentZoneId,
        });

        updateSpatialProximity();
      }
    );

    // Admin updates a dummy user (name, status, voice/speaking, mute, etc.)
    socket.on(
      'dummy:update',
      (payload: { dummyId: string; updates: Partial<User> }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const dummy = users.get(payload?.dummyId);
        if (!dummy || !dummy.isDummy) return;

        const { updates } = payload;
        if (!updates) return;

        if (typeof updates.name === 'string' && updates.name.trim()) {
          dummy.name = updates.name.trim();
        }
        if (updates.avatar) {
          dummy.avatar = { ...dummy.avatar, ...updates.avatar };
        }
        if (updates.presenceStatus && ['available', 'busy', 'dnd'].includes(updates.presenceStatus)) {
          dummy.presenceStatus = updates.presenceStatus;
        }
        if (typeof updates.isSpeaking === 'boolean') {
          dummy.isSpeaking = updates.isSpeaking;
        }
        if (typeof updates.isMuted === 'boolean') {
          dummy.isMuted = updates.isMuted;
        }
        if (updates.direction && ['up', 'down', 'left', 'right'].includes(updates.direction)) {
          dummy.direction = updates.direction;
        }

        emitToAdmins('user:updated', dummy);
      }
    );

    // Admin removes a dummy user
    socket.on('dummy:remove', (payload: { dummyId: string }) => {
      const sender = users.get(socket.id);
      if (!sender?.isAdmin) return;

      const dummy = users.get(payload?.dummyId);
      if (!dummy || !dummy.isDummy) return;

      users.delete(payload.dummyId);
      emitToAdmins('user:left', payload.dummyId);
      updateSpatialProximity();
    });

    // Admin triggers dummy to say something in chat (only visible to admins!)
    socket.on(
      'dummy:chat',
      (payload: { dummyId: string; text: string; isSpatial: boolean }) => {
        const sender = users.get(socket.id);
        if (!sender?.isAdmin) return;

        const dummy = users.get(payload?.dummyId);
        if (!dummy || !dummy.isDummy) return;
        if (!payload.text?.trim()) return;

        const chatMsg: ChatMessage = {
          id: \msg_\_\\,
          senderId: dummy.socketId,
          senderName: dummy.name,
          text: payload.text.trim(),
          timestamp: Date.now(),
          isSpatial: Boolean(payload.isSpatial),
          senderPosition: { ...dummy.position },
        };

        if (payload.isSpatial) {
          const PROXIMITY_CHAT_RADIUS = 8;
          for (const [sId, otherUser] of users.entries()) {
            if (!otherUser.isAdmin || otherUser.isDummy) continue;
            const dist = Math.hypot(
              dummy.position.x - otherUser.position.x,
              dummy.position.y - otherUser.position.y
            );
            if (dist <= PROXIMITY_CHAT_RADIUS) {
              io.to(sId).emit('chat:message', chatMsg);
            }
          }
        } else {
          for (const [sId, otherUser] of users.entries()) {
            if (otherUser.isAdmin && !otherUser.isDummy) {
              io.to(sId).emit('chat:message', chatMsg);
            }
          }
        }
      }
    );

 + disconnectAnchor;

if (!code.includes(disconnectAnchor)) {
  console.error('Could not find disconnectAnchor');
  process.exit(1);
}
code = code.replace(disconnectAnchor, dummyHandlers);

fs.writeFileSync('server.ts', code);
console.log('Successfully updated server.ts!');
