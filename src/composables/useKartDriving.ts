import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { Socket } from 'socket.io-client';
import type { GridMap, User } from '../types';
import {
  directionFromHeading,
  isBoosting,
  isSliding,
  normalizeAngle,
  speedOf,
  stepKart,
  type KartInput,
  type KartState,
  type KartWorld,
  type Surface,
} from '../lib/kart';
import { DEFAULT_KART_MODEL, isKartModel, type KartModel } from '../lib/kartModels';

/** localStorage key for the car the user last picked. */
export const KART_MODEL_STORAGE_KEY = 'peerspace_kart_model';

function loadSelectedModel(): KartModel {
  try {
    const stored = localStorage.getItem(KART_MODEL_STORAGE_KEY);
    return isKartModel(stored) ? stored : DEFAULT_KART_MODEL;
  } catch {
    return DEFAULT_KART_MODEL;
  }
}

function persistSelectedModel(model: KartModel) {
  try {
    localStorage.setItem(KART_MODEL_STORAGE_KEY, model);
  } catch {
    // Storage can be unavailable (private mode, quota); the choice then lasts for this session.
  }
}

/** Minimum gap between two user:move messages while driving (ms). */
export const KART_SEND_INTERVAL_MS = 66;
/** Position or heading change (tiles / radians) that counts as movement worth sending. */
export const KART_SEND_EPSILON = 0.01;
/** Below this speed (tiles/s) the kart counts as resting, and any remaining change is sent. */
export const KART_REST_SPEED = 0.05;
const KART_REST_EPSILON = 1e-6;
/** How long a kart:toggle failure stays visible (ms). */
const KART_ERROR_MS = 4000;

const DRIVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ShiftLeft',
  'ShiftRight',
]);

const SOLID_TILES = new Set(['wall_brick', 'wall_wood', 'water']);

/**
 * The drivable surface of a map as a flat lookup. Out-of-bounds and missing tiles are solid, as
 * are walls, water and the footprint of every blocking object (portals never are). Grass is
 * offroad; every other floor, asphalt included, is road.
 */
export function kartWorldFromMap(map: GridMap): KartWorld {
  const { width, height } = map;
  const cells: Surface[] = new Array<Surface>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = map.tiles[y]?.[x];
      let surface: Surface;
      if (tile === undefined || SOLID_TILES.has(tile)) surface = 'solid';
      else if (tile === 'floor_grass') surface = 'offroad';
      else surface = 'road';
      cells[y * width + x] = surface;
    }
  }
  for (const obj of map.objects) {
    if (obj.type === 'portal' || !obj.isBlocking) continue;
    const w = obj.width || 1;
    const h = obj.height || 1;
    for (let y = obj.y; y < obj.y + h; y++) {
      for (let x = obj.x; x < obj.x + w; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = 'solid';
      }
    }
  }
  return {
    surfaceAt(tx, ty) {
      if (!Number.isInteger(tx) || !Number.isInteger(ty)) return 'solid';
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) return 'solid';
      return cells[ty * width + tx];
    },
  };
}

/** The held driving keys as a kart input. Forward and reverse, left and right cancel out. */
export function kartInputFromKeys(held: ReadonlySet<string>): KartInput {
  const any = (...codes: string[]) => codes.some((c) => held.has(c));
  const throttle = (any('KeyW', 'ArrowUp') ? 1 : 0) - (any('KeyS', 'ArrowDown') ? 1 : 0);
  // Positive steer turns clockwise on screen, i.e. to the kart's right.
  const steer = (any('KeyD', 'ArrowRight') ? 1 : 0) - (any('KeyA', 'ArrowLeft') ? 1 : 0);
  return {
    throttle,
    steer,
    drift: any('Space'),
    boost: any('ShiftLeft', 'ShiftRight'),
  };
}

export interface KartSendRecord {
  x: number;
  y: number;
  heading: number;
  boost: boolean;
  /** performance.now() timestamp of the send (ms). */
  at: number;
}

/**
 * Whether to send a user:move now. Compares against the last thing actually sent, so small
 * changes accumulate until they cross the threshold. Sends are spaced at least
 * KART_SEND_INTERVAL_MS apart. A resting kart uses a much tighter threshold so its final
 * resting position always reaches the server. A change in boosting counts as a change.
 */
export function shouldSendKartMove(
  last: KartSendRecord | null,
  cur: { x: number; y: number; heading: number; boosting?: boolean },
  now: number,
  resting: boolean,
): boolean {
  if (!last) return true;
  if (now - last.at < KART_SEND_INTERVAL_MS) return false;
  if ((cur.boosting === true) !== last.boost) return true;
  const eps = resting ? KART_REST_EPSILON : KART_SEND_EPSILON;
  const moved = Math.hypot(cur.x - last.x, cur.y - last.y);
  const turned = Math.abs(normalizeAngle(cur.heading - last.heading));
  return moved > eps || turned > eps;
}

export interface UseKartDrivingOptions {
  socket: Ref<Socket | null>;
  currentUser: Ref<User>;
  currentMap: Ref<GridMap>;
  /** Gates the K shortcut and toggle. Defaults to always joined. */
  joined?: Ref<boolean>;
}

/**
 * Drives the local user's kart. The server decides who is in a kart (user.kart); while it is
 * set this simulates the kart at the display rate, keeps currentUser's position and heading in
 * step with the simulation, and streams the result to the server via user:move.
 */
export function useKartDriving(options: UseKartDrivingOptions) {
  const { socket, currentUser, currentMap } = options;
  const joined = options.joined ?? computed(() => true);

  const driving = computed(() => Boolean(currentUser.value.kart));
  const kartState = ref<KartState | null>(null);
  const kartError = ref<string | null>(null);
  /** The car picked in the selector. While driving, the kart's own model is the one simulated. */
  const selectedModel = ref<KartModel>(loadSelectedModel());
  const speed = computed(() => (kartState.value ? speedOf(kartState.value) : 0));
  const sliding = computed(() => (kartState.value ? isSliding(kartState.value) : false));
  /** Boost energy 0..1 for the HUD meter. A full tank when not driving. */
  const boostEnergy = computed(() => kartState.value?.boost ?? 1);
  const boosting = computed(() => (kartState.value ? isBoosting(kartState.value) : false));
  const world = computed(() => kartWorldFromMap(currentMap.value));

  const held = new Set<string>();
  let rafId: number | null = null;
  let lastFrameAt = 0;
  let lastSent: KartSendRecord | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  function tick(now: number) {
    const cur = kartState.value;
    const user = currentUser.value;
    if (!cur || !user.kart) return;
    const dt = (now - lastFrameAt) / 1000;
    lastFrameAt = now;

    // Per-frame state lives in kartState only. currentUser is written at send cadence: its
    // deep watchers (proximity media, saved position) are too costly to run at 60 Hz.
    const model = user.kart.model ?? selectedModel.value;
    const next = stepKart(cur, kartInputFromKeys(held), dt, world.value, model);
    kartState.value = next;

    const resting = speedOf(next) < KART_REST_SPEED;
    if (shouldSendKartMove(lastSent, next, now, resting)) {
      const direction = directionFromHeading(next.heading);
      const boost = isBoosting(next);
      user.position = { x: next.x, y: next.y };
      user.direction = direction;
      user.kart.heading = next.heading;
      user.kart.boost = boost;
      socket.value?.emit('user:move', {
        x: next.x,
        y: next.y,
        direction,
        heading: next.heading,
        boost,
      });
      lastSent = { x: next.x, y: next.y, heading: next.heading, boost, at: now };
    }
  }

  function frame() {
    rafId = null;
    if (!kartState.value) return;
    tick(performance.now());
    if (kartState.value) rafId = requestAnimationFrame(frame);
  }

  function startDriving() {
    const user = currentUser.value;
    if (!user.kart) return;
    kartState.value = {
      x: user.position.x,
      y: user.position.y,
      heading: user.kart.heading,
      vx: 0,
      vy: 0,
      boost: 1,
      boosting: false,
    };
    held.clear();
    lastSent = null;
    lastFrameAt = performance.now();
    if (rafId === null) rafId = requestAnimationFrame(frame);
  }

  function stopDriving() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    held.clear();
    lastSent = null;
    kartState.value = null;
  }

  function setError(message: string) {
    kartError.value = message;
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      kartError.value = null;
      errorTimer = null;
    }, KART_ERROR_MS);
  }

  /**
   * Picks a car. Remembered for next time. While driving, the server switches the kart to it
   * and the local copy follows once the server accepts.
   */
  function selectModel(model: KartModel) {
    if (!isKartModel(model)) return;
    selectedModel.value = model;
    persistSelectedModel(model);
    const sk = socket.value;
    if (!sk || !currentUser.value.kart) return;
    sk.emit('kart:select', { model }, (ack?: { ok?: boolean; error?: string }) => {
      if (!ack?.ok) {
        setError(ack?.error || 'Could not change car.');
        return;
      }
      const kart = currentUser.value.kart;
      if (kart) kart.model = model;
    });
  }

  function toggleKart() {
    const sk = socket.value;
    if (!sk || !joined.value) return;
    if (!driving.value && !currentMap.value.allowKarts) return;
    // Mounting takes the selected car; dismounting needs no payload.
    const payload = driving.value ? {} : { model: selectedModel.value };
    sk.emit('kart:toggle', payload, (ack?: { ok?: boolean; error?: string }) => {
      if (!ack?.ok) setError(ack?.error || 'Could not change kart.');
    });
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable === true;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (isEditableTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyK') {
      if (e.repeat) return;
      if (!driving.value && !currentMap.value.allowKarts) return;
      e.preventDefault();
      toggleKart();
      return;
    }
    if (!kartState.value || !DRIVE_KEYS.has(e.code)) return;
    // Arrow keys would otherwise scroll the page, and Space would scroll it or press a focused button.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    held.add(e.code);
  }

  function onKeyUp(e: KeyboardEvent) {
    held.delete(e.code);
  }

  function clearHeld() {
    held.clear();
  }

  function onVisibilityChange() {
    if (document.hidden) held.clear();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearHeld);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  // Hopping in or out: the server is the authority on who is driving.
  watch(driving, (on) => {
    if (on) startDriving();
    else stopDriving();
  }, { immediate: true });

  // A different map (portal, or an admin switching presets) ends the drive. The server clears
  // user.kart on its side too.
  watch(() => currentMap.value.id, () => stopDriving());

  function cleanup() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearHeld);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    stopDriving();
    if (errorTimer !== null) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  }

  if (getCurrentScope()) onScopeDispose(cleanup);

  return {
    driving,
    kartState,
    kartError,
    speed,
    sliding,
    boostEnergy,
    boosting,
    toggleKart,
    selectedModel,
    selectModel,
  };
}
