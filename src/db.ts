import fs from 'fs';
import path from 'path';
import type { GridMap } from './types';

const DB_FILE = path.join(process.cwd(), 'workspace.sqlite');

export interface SQLiteDriver {
  saveMap(map: GridMap): void;
  loadMaps(): GridMap[];
  saveActiveMapId(mapId: string): void;
  loadActiveMapId(): string | null;
  getDbInfo(): { driver: string; path: string; totalMaps: number; fileSize: number };
}

export async function initWorkspaceDatabase(): Promise<SQLiteDriver> {
  // Check if Bun runtime exists
  if (typeof (globalThis as any).Bun !== 'undefined') {
    try {
      // @ts-ignore - Bun built-in sqlite module
      const { Database } = await import('bun:sqlite');
      const db = new Database(DB_FILE);
      db.run(`
        CREATE TABLE IF NOT EXISTS workspace_maps (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS workspace_active (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      return {
        saveMap(map: GridMap) {
          const stmt = db.prepare(`
            INSERT INTO workspace_maps (id, name, data, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              data = excluded.data,
              updated_at = excluded.updated_at
          `);
          stmt.run(map.id, map.name, JSON.stringify(map), Date.now());
        },
        loadMaps(): GridMap[] {
          const rows: any[] = db.prepare('SELECT data FROM workspace_maps ORDER BY updated_at DESC').all();
          const maps: GridMap[] = [];
          for (const row of rows) {
            try {
              maps.push(JSON.parse(row.data));
            } catch (e) {}
          }
          return maps;
        },
        saveActiveMapId(mapId: string) {
          const stmt = db.prepare(`
            INSERT INTO workspace_active (key, value)
            VALUES ('current_map_id', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `);
          stmt.run(mapId);
        },
        loadActiveMapId(): string | null {
          const row: any = db.prepare("SELECT value FROM workspace_active WHERE key = 'current_map_id'").get();
          return row ? row.value : null;
        },
        getDbInfo() {
          const stats = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE) : { size: 0 };
          const mapsCount: any = db.prepare('SELECT COUNT(*) as count FROM workspace_maps').get();
          return {
            driver: 'bun:sqlite',
            path: DB_FILE,
            totalMaps: mapsCount ? mapsCount.count : 0,
            fileSize: stats.size,
          };
        },
      };
    } catch (err) {
      console.warn('Bun SQLite initialization fallback:', err);
    }
  }

  // Fallback to sql.js for Node.js engine
  try {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    let filebuffer: Uint8Array | null = null;
    if (fs.existsSync(DB_FILE)) {
      filebuffer = fs.readFileSync(DB_FILE);
    }
    const db = filebuffer ? new SQL.Database(filebuffer) : new SQL.Database();
    
    db.run(`
      CREATE TABLE IF NOT EXISTS workspace_maps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS workspace_active (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const persistToDisk = () => {
      try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_FILE, buffer);
      } catch (e) {
        console.error('Failed to write SQLite database to disk:', e);
      }
    };

    if (!filebuffer) {
      persistToDisk();
    }

    return {
      saveMap(map: GridMap) {
        db.run(
          `INSERT OR REPLACE INTO workspace_maps (id, name, data, updated_at) VALUES (?, ?, ?, ?)`,
          [map.id, map.name, JSON.stringify(map), Date.now()]
        );
        persistToDisk();
      },
      loadMaps(): GridMap[] {
        const res = db.exec('SELECT data FROM workspace_maps ORDER BY updated_at DESC');
        if (res.length === 0 || !res[0].values) return [];
        const maps: GridMap[] = [];
        for (const row of res[0].values) {
          try {
            maps.push(JSON.parse(row[0] as string));
          } catch (e) {}
        }
        return maps;
      },
      saveActiveMapId(mapId: string) {
        db.run(`INSERT OR REPLACE INTO workspace_active (key, value) VALUES ('current_map_id', ?)`, [mapId]);
        persistToDisk();
      },
      loadActiveMapId(): string | null {
        const res = db.exec("SELECT value FROM workspace_active WHERE key = 'current_map_id'");
        if (res.length > 0 && res[0].values && res[0].values.length > 0) {
          return res[0].values[0][0] as string;
        }
        return null;
      },
      getDbInfo() {
        const stats = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE) : { size: 0 };
        const res = db.exec('SELECT COUNT(*) FROM workspace_maps');
        const count = res.length > 0 && res[0].values ? (res[0].values[0][0] as number) : 0;
        return {
          driver: 'sql.js (sqlite)',
          path: DB_FILE,
          totalMaps: count,
          fileSize: stats.size,
        };
      },
    };
  } catch (err) {
    console.error('Failed to initialize SQLite database:', err);
    throw err;
  }
}
