import { GridMap, TileType, MapObject, PrivateZone } from './types';

export function createDefaultOfficeMap(): GridMap {
  const width = 32;
  const height = 24;
  
  // Initialize floor tiles
  const tiles: TileType[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) {
      // Outer walls
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        row.push('wall_brick');
      } else if (y === 10 && x < 22 && x !== 10 && x !== 11) {
        // Divider wall between top office and lower lounge
        row.push('wall_wood');
      } else if (x >= 22 && y >= 12) {
        // Outdoor grass terrace
        row.push('floor_grass');
      } else if (x < 12 && y < 10) {
        // Meeting room tile
        row.push('floor_carpet');
      } else {
        // Main office wood floor
        row.push('floor_wood');
      }
    }
    tiles.push(row);
  }

  const privateZones: PrivateZone[] = [
    {
      id: 'zone_meeting_a',
      name: 'Meeting Room Alpha',
      color: 'rgba(59, 130, 246, 0.18)',
      x: 1,
      y: 1,
      width: 10,
      height: 8,
    },
    {
      id: 'zone_executive_lounge',
      name: 'Lounge & Arcade',
      color: 'rgba(168, 85, 247, 0.18)',
      x: 1,
      y: 11,
      width: 12,
      height: 11,
    },
    {
      id: 'zone_terrace',
      name: 'Outdoor Patio',
      color: 'rgba(34, 197, 94, 0.18)',
      x: 22,
      y: 12,
      width: 9,
      height: 10,
    }
  ];

  const objects: MapObject[] = [
    // Whiteboard in Meeting Room Alpha
    {
      id: 'wb_1',
      type: 'whiteboard',
      name: 'Alpha Whiteboard',
      x: 2,
      y: 1,
      width: 3,
      height: 1,
      isBlocking: true,
      data: {
        whiteboardStrokes: [],
      }
    },
    // Meeting Room Table & Chairs
    {
      id: "table_meeting",
      type: "conference_table",
      name: "Conference Table",
      x: 3,
      y: 4,
      width: 4,
      height: 2,
      isBlocking: true,
    },
    // Sticky note board
    {
      id: 'sticky_1',
      type: 'sticky_notes',
      name: 'Ideas Bulletin Board',
      x: 8,
      y: 1,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        notes: [
          {
            id: 'note_1',
            author: 'Alex',
            text: 'Welcome to PeerSpace! Use WASD to move and press E near objects!',
            color: '#fef08a',
            createdAt: Date.now() - 100000,
          },
          {
            id: 'note_2',
            author: 'Sarah',
            text: 'Proximity audio connects automatically when standing near coworkers.',
            color: '#bae6fd',
            createdAt: Date.now() - 50000,
          }
        ]
      }
    },
    // Workstation Desks in main area with claimable user desk states
    {
      id: 'desk_1',
      type: 'desk',
      name: 'Open Workstation 1',
      x: 14,
      y: 3,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 1',
          equipment: 'dual_monitors',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_2',
      type: 'desk',
      name: 'Open Workstation 2',
      x: 17,
      y: 3,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 2',
          equipment: 'designer_tablet',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_3',
      type: 'desk',
      name: 'Open Workstation 3',
      x: 14,
      y: 6,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 3',
          equipment: 'laptop',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_4',
      type: 'desk',
      name: 'Open Workstation 4',
      x: 17,
      y: 6,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 4',
          equipment: 'gaming_rig',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_5',
      type: 'desk',
      name: 'Executive Corner Desk',
      x: 25,
      y: 7,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Executive Suite Desk',
          statusNote: '☕ Open for 1-on-1 syncs & strategy discussions',
          equipment: 'dual_monitors',
          stickyNotes: []
        }
      }
    },
    
    // Plants for decoration
    { id: 'plant_1', type: 'plant', name: 'Monstera Plant', x: 12, y: 1, width: 1, height: 1, isBlocking: true },
    { id: 'plant_2', type: 'plant', name: 'Fiddle Leaf Fig', x: 21, y: 1, width: 1, height: 1, isBlocking: true },
    { id: 'plant_3', type: 'plant', name: 'Terrace Palm', x: 22, y: 12, width: 1, height: 1, isBlocking: true },

    // Coffee Machine in Lounge
    { id: 'coffee_1', type: 'coffee_machine', name: 'Espresso Bar', x: 2, y: 12, width: 2, height: 1, isBlocking: true },

    // Jukebox / Lofi Radio
    { 
      id: 'jukebox_1', 
      type: 'jukebox', 
      name: 'Lofi Audio Player', 
      x: 1, 
      y: 15, 
      width: 1, 
      height: 2, 
      isBlocking: true,
      data: {
        jukeboxState: {
          isPlaying: false,
          trackIndex: 0,
          trackName: 'Relaxing Chill Beats'
        }
      }
    },

    // Arcade Game Table
    { 
      id: 'game_1', 
      type: 'game_table', 
      name: 'Arcade Tic-Tac-Toe', 
      x: 6, 
      y: 15, 
      width: 2, 
      height: 2, 
      isBlocking: true,
      data: {
        gameState: {
          board: Array(9).fill(null),
          turn: 'X',
          winner: null,
          players: {}
        }
      }
    },

    // Presentation TV / Screen
    {
      id: 'tv_1',
      type: 'tv',
      name: 'Presentation Screen',
      x: 25,
      y: 1,
      width: 4,
      height: 1,
      isBlocking: true,
      data: {
        videoUrl: 'https://www.youtube.com/embed/jfKfPfyJRdk'
      }
    }
  ];

  return {
    id: 'office_default',
    name: 'Tech Startup HQ',
    width,
    height,
    tiles,
    objects,
    privateZones,
    spawnPoint: { x: 15, y: 12 }
  };
}

export function createBeachRetreatMap(): GridMap {
  const width = 28;
  const height = 20;
  const tiles: TileType[][] = [];

  for (let y = 0; y < height; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        row.push('wall_brick');
      } else if (y > 14) {
        row.push('water');
      } else if (y > 8) {
        row.push('floor_concrete'); // sand
      } else {
        row.push('floor_wood'); // wooden dock/deck
      }
    }
    tiles.push(row);
  }

  return {
    id: 'beach_retreat',
    name: 'Beachside Deck',
    width,
    height,
    tiles,
    objects: [
      { id: "b_plant1", type: "plant", name: "Palm Tree", x: 2, y: 2, width: 2, height: 2, isBlocking: true },
      { id: "b_table1", type: "conference_table", name: "Conference Table", x: 8, y: 4, width: 3, height: 2, isBlocking: true },
      { id: 'b_wb1', type: 'whiteboard', name: 'Sunset Brainstorm', x: 15, y: 2, width: 3, height: 1, isBlocking: true, data: { whiteboardStrokes: [] } },
      { id: 'b_juke1', type: 'jukebox', name: 'Ocean Waves Audio', x: 22, y: 3, width: 1, height: 2, isBlocking: true, data: { jukeboxState: { isPlaying: false, trackIndex: 1, trackName: 'Ocean Waves' } } }
    ],
    privateZones: [
      { id: 'z_deck', name: 'Sun Deck Pod', color: 'rgba(234, 179, 8, 0.2)', x: 6, y: 2, width: 8, height: 6 }
    ],
    spawnPoint: { x: 14, y: 10 }
  };
}
