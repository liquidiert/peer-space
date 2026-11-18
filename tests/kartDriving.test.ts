import { effectScope, ref, shallowRef, watch, type EffectScope, type Ref } from 'vue';
import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GridMap, MapObject, TileType, User } from '../src/types';
import {
  KART_MODEL_STORAGE_KEY,
  KART_SEND_INTERVAL_MS,
  kartInputFromKeys,
  kartWorldFromMap,
  shouldSendKartMove,
  useKartDriving,
  type KartSendRecord,
} from '../src/composables/useKartDriving';
import type { KartModel } from '../src/lib/kartModels';

/** A small map: floor_wood everywhere unless overridden by the tile rows below. */
function makeMap(rows: TileType[][], objects: MapObject[] = [], extra: Partial<GridMap> = {}): GridMap {
  return {
    id: 'test_map',
    name: 'Test',
    width: rows[0].length,
    height: rows.length,
    tiles: rows,
    objects,
    privateZones: [],
    spawnPoint: { x: 1, y: 1 },
    allowKarts: true,
    ...extra,
  };
}

function floorRow(width: number, tile: TileType = 'floor_concrete'): TileType[] {
  return Array.from({ length: width }, () => tile);
}

function makeObject(partial: Partial<MapObject> & Pick<MapObject, 'id' | 'type' | 'x' | 'y'>): MapObject {
  return { name: partial.id, width: 1, height: 1, isBlocking: true, ...partial };
}

function makeUser(partial: Partial<User> = {}): User {
  return {
    id: 'u1',
    socketId: 's1',
    name: 'Driver',
    position: { x: 2, y: 2 },
    direction: 'right',
    avatar: {} as User['avatar'],
    isMuted: false,
    isDeafened: false,
    isSpeaking: false,
    isScreenSharing: false,
    currentZoneId: null,
    lastSeen: 0,
    presenceStatus: 'available',
    mapId: 'test_map',
    kart: null,
    ...partial,
  } as User;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('kartWorldFromMap', () => {
  const rows: TileType[][] = [
    ['wall_brick', 'wall_wood', 'water', 'floor_grass', 'floor_concrete', 'floor_wood'],
    ['floor_tile', 'floor_carpet', 'floor_grass', 'floor_grass', 'floor_concrete', 'floor_concrete'],
  ];
  const world = kartWorldFromMap(
    makeMap(rows, [
      makeObject({ id: 'desk', type: 'desk', x: 4, y: 1, width: 2, height: 1 }),
      makeObject({ id: 'chair', type: 'chair', x: 1, y: 0, width: 1, height: 1, isBlocking: false }),
      makeObject({ id: 'portal', type: 'portal', x: 5, y: 0, width: 1, height: 1, isBlocking: true }),
    ]),
  );

  it('treats walls and water as solid', () => {
    expect(world.surfaceAt(0, 0)).toBe('solid');
    expect(world.surfaceAt(1, 0)).toBe('solid');
    expect(world.surfaceAt(2, 0)).toBe('solid');
  });

  it('reports grass as offroad', () => {
    expect(world.surfaceAt(3, 0)).toBe('offroad');
    expect(world.surfaceAt(2, 1)).toBe('offroad');
  });

  it('reports concrete and other floors as road', () => {
    expect(world.surfaceAt(4, 0)).toBe('road');
    expect(world.surfaceAt(5, 0)).toBe('road');
    expect(world.surfaceAt(0, 1)).toBe('road');
    expect(world.surfaceAt(1, 1)).toBe('road');
  });

  it('treats out-of-bounds and non-integer tiles as solid', () => {
    expect(world.surfaceAt(-1, 0)).toBe('solid');
    expect(world.surfaceAt(0, -1)).toBe('solid');
    expect(world.surfaceAt(6, 0)).toBe('solid');
    expect(world.surfaceAt(0, 2)).toBe('solid');
    expect(world.surfaceAt(0.5, 0)).toBe('solid');
  });

  it('makes every tile of a blocking object footprint solid, and nothing beyond it', () => {
    expect(world.surfaceAt(4, 1)).toBe('solid');
    expect(world.surfaceAt(5, 1)).toBe('solid');
    expect(world.surfaceAt(3, 1)).toBe('offroad');
  });

  it('leaves non-blocking objects and portals drivable', () => {
    const chairWorld = kartWorldFromMap(
      makeMap([floorRow(3)], [makeObject({ id: 'c', type: 'chair', x: 1, y: 0, isBlocking: false })]),
    );
    expect(chairWorld.surfaceAt(1, 0)).toBe('road');
    expect(world.surfaceAt(5, 0)).toBe('road'); // blocking portal: portals are never solid
  });
});

describe('kartInputFromKeys', () => {
  it('maps throttle, steer, drift and boost from held codes', () => {
    const none = { drift: false, boost: false };
    expect(kartInputFromKeys(new Set())).toEqual({ throttle: 0, steer: 0, ...none });
    expect(kartInputFromKeys(new Set(['KeyW']))).toEqual({ throttle: 1, steer: 0, ...none });
    expect(kartInputFromKeys(new Set(['ArrowUp']))).toEqual({ throttle: 1, steer: 0, ...none });
    expect(kartInputFromKeys(new Set(['KeyS']))).toEqual({ throttle: -1, steer: 0, ...none });
    expect(kartInputFromKeys(new Set(['ArrowDown']))).toEqual({ throttle: -1, steer: 0, ...none });
    expect(kartInputFromKeys(new Set(['KeyD']))).toEqual({ throttle: 0, steer: 1, ...none });
    expect(kartInputFromKeys(new Set(['ArrowRight']))).toEqual({ throttle: 0, steer: 1, ...none });
    expect(kartInputFromKeys(new Set(['KeyA']))).toEqual({ throttle: 0, steer: -1, ...none });
    expect(kartInputFromKeys(new Set(['ArrowLeft']))).toEqual({ throttle: 0, steer: -1, ...none });
  });

  it('cancels opposite keys out', () => {
    expect(kartInputFromKeys(new Set(['KeyW', 'KeyS']))).toMatchObject({ throttle: 0 });
    expect(kartInputFromKeys(new Set(['KeyA', 'ArrowRight']))).toMatchObject({ steer: 0 });
  });

  it('drifts on Space and boosts on either shift', () => {
    expect(kartInputFromKeys(new Set(['Space']))).toMatchObject({ drift: true, boost: false });
    expect(kartInputFromKeys(new Set(['ShiftLeft']))).toMatchObject({ drift: false, boost: true });
    expect(kartInputFromKeys(new Set(['ShiftRight']))).toMatchObject({ drift: false, boost: true });
    expect(kartInputFromKeys(new Set(['ShiftRight', 'Space']))).toMatchObject({ drift: true, boost: true });
  });
});

describe('shouldSendKartMove', () => {
  const at = 1000;
  const last: KartSendRecord = { x: 5, y: 5, heading: 0, boost: false, at };

  it('always sends the first move', () => {
    expect(shouldSendKartMove(null, { x: 5, y: 5, heading: 0 }, at, false)).toBe(true);
  });

  it('sends a boost change, but still respects the interval', () => {
    const cur = { x: 5, y: 5, heading: 0, boosting: true };
    expect(shouldSendKartMove(last, cur, at + KART_SEND_INTERVAL_MS - 1, false)).toBe(false);
    expect(shouldSendKartMove(last, cur, at + KART_SEND_INTERVAL_MS, false)).toBe(true);
    const boostedLast: KartSendRecord = { ...last, boost: true };
    expect(shouldSendKartMove(boostedLast, { x: 5, y: 5, heading: 0, boosting: false }, at + 500, false)).toBe(true);
    expect(shouldSendKartMove(boostedLast, { x: 5, y: 5, heading: 0, boosting: true }, at + 500, false)).toBe(false);
  });

  it('holds back sends inside the interval, however far the kart has moved', () => {
    const cur = { x: 6, y: 5, heading: 0 };
    expect(shouldSendKartMove(last, cur, at + KART_SEND_INTERVAL_MS - 1, false)).toBe(false);
    expect(shouldSendKartMove(last, cur, at + KART_SEND_INTERVAL_MS, false)).toBe(true);
  });

  it('ignores movement and turning at or below 0.01', () => {
    const now = at + 500;
    expect(shouldSendKartMove(last, { x: 5.005, y: 5, heading: 0.005 }, now, false)).toBe(false);
    expect(shouldSendKartMove(last, { x: 5.02, y: 5, heading: 0 }, now, false)).toBe(true);
    expect(shouldSendKartMove(last, { x: 5, y: 5, heading: 0.02 }, now, false)).toBe(true);
  });

  it('compares wrapped headings, so a turn across +-PI counts as a small change', () => {
    const nearPi = { x: 5, y: 5, heading: Math.PI - 0.001 };
    const lastNearPi: KartSendRecord = { ...nearPi, heading: -Math.PI + 0.001, boost: false, at };
    expect(shouldSendKartMove(lastNearPi, nearPi, at + 500, false)).toBe(false);
  });

  it('sends a tiny settling change once the kart is resting', () => {
    const now = at + 500;
    const settle = { x: 5.0001, y: 5, heading: 0 };
    expect(shouldSendKartMove(last, settle, now, false)).toBe(false);
    expect(shouldSendKartMove(last, settle, now, true)).toBe(true);
    // Nothing changed: nothing to say, resting or not.
    expect(shouldSendKartMove(last, { x: 5, y: 5, heading: 0 }, now, true)).toBe(false);
  });

  it('still respects the interval for resting sends', () => {
    const settle = { x: 5.0001, y: 5, heading: 0 };
    expect(shouldSendKartMove(last, settle, at + 10, true)).toBe(false);
  });
});

describe('useKartDriving', () => {
  let scope: EffectScope | undefined;
  let emit: Mock;
  let socket: Ref<Socket | null>;
  let user: Ref<User>;
  let map: Ref<GridMap>;

  const rows = Array.from({ length: 8 }, () => floorRow(12, 'floor_concrete'));

  function setup(
    mapOverrides: Partial<GridMap> = {},
    userOverrides: Partial<User> = {},
    mapRows: TileType[][] = rows,
  ) {
    emit = vi.fn();
    socket = shallowRef({ emit } as unknown as Socket);
    user = ref(makeUser(userOverrides));
    map = ref(makeMap(mapRows, [], mapOverrides));
    scope = effectScope();
    return scope.run(() => useKartDriving({ socket, currentUser: user, currentMap: map }))!;
  }

  beforeEach(() => {
    localStorage.clear();
  });

  function press(code: string, target: EventTarget = window, type: 'keydown' | 'keyup' = 'keydown', repeat = false) {
    const ev = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, repeat });
    target.dispatchEvent(ev);
    return ev;
  }

  afterEach(() => {
    scope?.stop();
  });

  it('starts from the user position and heading when the kart is set, and stops when cleared', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    expect(kart.driving.value).toBe(true);
    expect(kart.kartState.value).toMatchObject({ x: 2, y: 2, heading: 0, vx: 0, vy: 0 });

    user.value = { ...user.value, kart: null };
    await sleep(0);
    expect(kart.driving.value).toBe(false);
    expect(kart.kartState.value).toBeNull();
  });

  it('accelerates with W and writes the simulated position back to the user', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    press('KeyW');
    await sleep(120);
    press('KeyW', window, 'keyup');
    expect(kart.speed.value).toBeGreaterThan(0);
    // The simulation runs per frame; the user position is what was last sent.
    expect(kart.kartState.value!.x).toBeGreaterThanOrEqual(user.value.position.x);
    expect(user.value.position.x).toBeGreaterThan(2);
    expect(user.value.position.y).toBeCloseTo(2, 5);
    expect(user.value.direction).toBe('right');
    expect(user.value.kart?.heading).toBeCloseTo(0, 5);
  });

  it('writes currentUser.position at send cadence, not every frame', async () => {
    setup({}, { kart: { heading: 0 } });
    let writes = 0;
    watch(() => user.value.position, () => writes++, { flush: 'sync' });
    press('KeyW');
    await sleep(300);
    press('KeyW', window, 'keyup');
    const sent = emit.mock.calls.filter(([event]) => event === 'user:move');
    // About 300 ms at 66 ms spacing is at most ~5 sends, against ~18 frames at 60 fps.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(6);
    expect(writes).toBe(sent.length);
    const last = sent[sent.length - 1][1] as { x: number; y: number };
    expect(user.value.position).toEqual({ x: last.x, y: last.y });
  });

  it('sends float positions with direction and heading while driving', async () => {
    setup({}, { kart: { heading: 0 } });
    press('KeyW');
    await sleep(120);
    press('KeyW', window, 'keyup');
    expect(emit).toHaveBeenCalled();
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe('user:move');
    expect(payload).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      direction: 'right',
      heading: 0,
      boost: false,
    });
  });

  it('sends boost true while shift is held, and exposes the energy meter', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    expect(kart.boostEnergy.value).toBe(1);
    expect(kart.boosting.value).toBe(false);
    press('KeyW');
    press('ShiftLeft');
    await sleep(100);
    expect(kart.boosting.value).toBe(true);
    expect(kart.boostEnergy.value).toBeLessThan(1);
    const boosted = emit.mock.calls.filter(([event, p]) => event === 'user:move' && (p as { boost: boolean }).boost);
    expect(boosted.length).toBeGreaterThan(0);
    expect(user.value.kart?.boost).toBe(true);
    press('ShiftLeft', window, 'keyup');
    press('KeyW', window, 'keyup');
  });

  it('prevents page scrolling for Space while driving', () => {
    setup({}, { kart: { heading: 0 } });
    const ev = press('Space');
    expect(ev.defaultPrevented).toBe(true);
    press('Space', window, 'keyup');
  });

  it('leaves Space alone when not driving', () => {
    setup({}, {});
    const ev = press('Space');
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ignores keys typed into an input', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('KeyW', input);
    await sleep(100);
    expect(kart.speed.value).toBe(0);
    input.remove();
  });

  it('clears held keys on window blur, so the throttle stops', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    press('KeyW');
    await sleep(60);
    window.dispatchEvent(new Event('blur'));
    const atBlur = kart.speed.value;
    expect(atBlur).toBeGreaterThan(0);
    await sleep(120);
    // Still coasting down under drag; with W still held it would have sped up instead.
    expect(kart.speed.value).toBeLessThan(atBlur);
  });

  it('turns clockwise with D and anticlockwise with A', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    press('KeyW');
    press('KeyD');
    await sleep(100);
    press('KeyD', window, 'keyup');
    const afterRight = kart.kartState.value!.heading;
    expect(afterRight).toBeGreaterThan(0);

    press('KeyA');
    await sleep(100);
    expect(kart.kartState.value!.heading).toBeLessThan(afterRight);
  });

  it('prevents page scrolling for arrow keys while driving', () => {
    setup({}, { kart: { heading: 0 } });
    const ev = press('ArrowUp');
    expect(ev.defaultPrevented).toBe(true);
    press('ArrowUp', window, 'keyup');
  });

  it('toggles the kart with K (not on repeat) when the map allows karts', () => {
    setup({}, {});
    press('KeyK');
    expect(emit).toHaveBeenCalledWith('kart:toggle', { model: 'kart' }, expect.any(Function));
    emit.mockClear();
    press('KeyK', window, 'keydown', true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not toggle the kart with K on a map without karts', () => {
    setup({ allowKarts: false }, {});
    press('KeyK');
    expect(emit).not.toHaveBeenCalled();
  });

  it('shows the server error from a failed toggle', () => {
    const kart = setup({}, {});
    emit.mockImplementation((_event: string, _payload: unknown, ack: (r: unknown) => void) => {
      ack({ ok: false, error: 'Nope' });
    });
    kart.toggleKart();
    expect(kart.kartError.value).toBe('Nope');
  });

  it('stops driving when the map changes', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    expect(kart.kartState.value).not.toBeNull();
    map.value = { ...map.value, id: 'other_map' };
    await sleep(0);
    expect(kart.kartState.value).toBeNull();
  });

  it('removes its listeners and loop when its scope is disposed', async () => {
    const kart = setup({}, { kart: { heading: 0 } });
    scope!.stop();
    scope = undefined;
    expect(kart.kartState.value).toBeNull();
    emit.mockClear();
    press('KeyW');
    press('KeyK');
    await sleep(60);
    expect(emit).not.toHaveBeenCalled();
  });

  describe('car selection', () => {
    it('defaults to the default car when nothing is stored', () => {
      expect(setup().selectedModel.value).toBe('kart');
    });

    it('restores a stored car and falls back to the default for an unknown one', () => {
      localStorage.setItem(KART_MODEL_STORAGE_KEY, 'buggy');
      expect(setup().selectedModel.value).toBe('buggy');
      scope!.stop();
      localStorage.setItem(KART_MODEL_STORAGE_KEY, 'tank');
      expect(setup().selectedModel.value).toBe('kart');
    });

    it('persists a picked car', () => {
      const kart = setup();
      kart.selectModel('racer');
      expect(kart.selectedModel.value).toBe('racer');
      expect(localStorage.getItem(KART_MODEL_STORAGE_KEY)).toBe('racer');
    });

    it('ignores an unknown car', () => {
      const kart = setup();
      kart.selectModel('tank' as KartModel);
      expect(kart.selectedModel.value).toBe('kart');
      expect(localStorage.getItem(KART_MODEL_STORAGE_KEY)).toBeNull();
    });

    it('sends the picked car when hopping in', () => {
      const kart = setup();
      kart.selectModel('drifter');
      kart.toggleKart();
      expect(emit).toHaveBeenCalledWith('kart:toggle', { model: 'drifter' }, expect.any(Function));
    });

    it('does not emit kart:select while walking', () => {
      const kart = setup();
      kart.selectModel('racer');
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits kart:select while driving, and applies the car once the server accepts it', () => {
      const kart = setup({}, { kart: { heading: 0, model: 'kart' } });
      emit.mockImplementation((_event: string, _payload: unknown, ack: (r: unknown) => void) => {
        ack({ ok: true });
      });
      kart.selectModel('buggy');
      expect(emit).toHaveBeenCalledWith('kart:select', { model: 'buggy' }, expect.any(Function));
      expect(user.value.kart?.model).toBe('buggy');
    });

    it('shows the server error and keeps the current car when kart:select fails', () => {
      const kart = setup({}, { kart: { heading: 0, model: 'kart' } });
      emit.mockImplementation((_event: string, _payload: unknown, ack: (r: unknown) => void) => {
        ack({ ok: false, error: 'Unknown car.' });
      });
      kart.selectModel('racer');
      expect(kart.kartError.value).toBe('Unknown car.');
      expect(user.value.kart?.model).toBe('kart');
    });

    it('simulates the kart with its own model: a racer outruns a buggy on road', async () => {
      const longRoad = Array.from({ length: 5 }, () => floorRow(80, 'floor_concrete'));
      const speedAfterHoldingW = async (model: KartModel) => {
        const kart = setup({}, { kart: { heading: 0, model } }, longRoad);
        press('KeyW');
        await sleep(1500);
        press('KeyW', window, 'keyup');
        const speed = kart.speed.value;
        scope!.stop();
        scope = undefined;
        return speed;
      };
      const racer = await speedAfterHoldingW('racer');
      const buggy = await speedAfterHoldingW('buggy');
      expect(racer).toBeGreaterThan(buggy);
    }, 10_000);
  });
});
