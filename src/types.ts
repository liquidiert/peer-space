export type Direction = 'up' | 'down' | 'left' | 'right';

export interface AvatarCustomization {
  skinColor: string;
  hairStyle: string;
  hairColor: string;
  outfitColor: string;
  glasses: boolean;
  hatStyle: string;
  statusEmoji: string;
}

export interface UserPosition {
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface User {
  id: string;
  socketId: string;
  name: string;
  position: UserPosition;
  direction: Direction;
  avatar: AvatarCustomization;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  isScreenSharing: boolean;
  isVideoOn?: boolean;
  isAdmin?: boolean;
  currentZoneId: string | null;
  lastSeen: number;
}

export type TileType = 
  | 'floor_wood' 
  | 'floor_carpet' 
  | 'floor_tile' 
  | 'floor_grass' 
  | 'floor_concrete'
  | 'wall_brick'
  | 'wall_wood'
  | 'water';

export type ObjectType = 
  | 'desk'
  | 'chair'
  | 'couch'
  | 'plant'
  | 'computer'
  | 'whiteboard'
  | 'sticky_notes'
  | 'game_table'
  | 'jukebox'
  | 'tv'
  | 'bookshelf'
  | 'coffee_machine'
  | 'door';

export interface DeskState {
  claimedByUserId?: string;
  claimedByUserName?: string;
  deskLabel?: string;
  statusNote?: string;
  equipment?: 'dual_monitors' | 'laptop' | 'gaming_rig' | 'designer_tablet' | 'keyboard';
  stickyNotes?: StickyNote[];
}

export interface MapObject {
  id: string;
  type: ObjectType;
  name: string;
  x: number; // grid x
  y: number; // grid y
  width: number; // in grid cells
  height: number; // in grid cells
  isBlocking: boolean;
  rotation?: number; // 0, 90, 180, 270
  data?: {
    whiteboardStrokes?: WhiteboardStroke[];
    notes?: StickyNote[];
    gameState?: GameTableState;
    jukeboxState?: JukeboxState;
    videoUrl?: string;
    deskState?: DeskState;
  };
}

export interface WhiteboardStroke {
  id: string;
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

export interface StickyNote {
  id: string;
  author: string;
  text: string;
  color: string;
  createdAt: number;
}

export interface GameTableState {
  board: (string | null)[];
  turn: 'X' | 'O';
  winner: string | null;
  players: {
    X?: { id: string; name: string };
    O?: { id: string; name: string };
  };
}

export interface JukeboxState {
  isPlaying: boolean;
  trackIndex: number;
  trackName: string;
}

export interface PrivateZone {
  id: string;
  name: string;
  color: string;
  x: number; // min tile x
  y: number; // min tile y
  width: number; // tile width
  height: number; // tile height
}

export interface GridMap {
  id: string;
  name: string;
  width: number;
  height: number;
  tiles: TileType[][]; // grid[y][x]
  objects: MapObject[];
  privateZones: PrivateZone[];
  spawnPoint: UserPosition;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSpatial: boolean;
  senderPosition?: UserPosition;
}

export interface WebRTCSignalData {
  from: string;
  to: string;
  signal: any;
}
