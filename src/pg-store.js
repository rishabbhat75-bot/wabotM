import { initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pg from 'pg';

export const usePostgresAuthState = async (dbUrl) => {
    // =========================================================================
    // 🔴 CRITICAL FIX FOR RENDER.COM FREE TIER
    // =========================================================================
    // Render free tier does NOT support IPv6 outbound connections.
    // Supabase direct connections (*.supabase.co) are IPv6-ONLY — no IPv4 at all.
    // Supabase pooler connections (*.pooler.supabase.com) also default to IPv6.
    // The ONLY way to connect from Render is through the IPv4 pooler endpoint.
    //
    // This code auto-detects ANY Supabase URL pattern and rewrites it to use
    // the IPv4-compatible Supavisor pooler with session mode (port 5432).
    // =========================================================================

    const originalUrl = dbUrl;

    try {
        const parsedUrl = new URL(dbUrl);

        if (parsedUrl.hostname.includes('supabase')) {
            // Case 1: Direct connection (e.g., aws-0-ap-south-1.supabase.co)
            // These are IPv6-ONLY. Must convert to pooler.
            if (!parsedUrl.hostname.includes('pooler.supabase.com')) {
                // Extract the region part: "aws-0-ap-south-1" from "aws-0-ap-south-1.supabase.co"
                const region = parsedUrl.hostname.split('.supabase')[0];
                parsedUrl.hostname = `${region}.pooler.supabase.com`;
                parsedUrl.port = '5432'; // Session mode for long-lived connections
                console.log(`🔧 Converted Supabase DIRECT connection to POOLER (Session mode).`);
            }

            // Case 2: Already a pooler URL but missing .ipv4. prefix
            if (parsedUrl.hostname.includes('.pooler.supabase.com') && !parsedUrl.hostname.includes('.ipv4.')) {
                parsedUrl.hostname = parsedUrl.hostname.replace('.pooler.supabase.com', '.ipv4.pooler.supabase.com');
                console.log(`🔧 Added IPv4 prefix to Supabase pooler URL.`);
            }

            dbUrl = parsedUrl.toString();
            console.log(`✅ Final Database URL: ${dbUrl.replace(/:[^:@]+@/, ':****@')}`); // Log with password hidden
        }
    } catch (e) {
        console.warn('⚠️ Could not parse DATABASE_URL for Supabase auto-fix. Using as-is.');
    }

    // We use a pool directly and keep it open
    const pool = new pg.Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false } // Required for Supabase/Neon
    });

    // Create table if it doesn't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth (
            id VARCHAR(255) PRIMARY KEY,
            data JSONB
        )
    `);
    await pool.query('TRUNCATE TABLE baileys_auth');

    // Helper to format keys correctly
    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

    const writeData = async (data, file) => {
        const id = fixFileName(file);
        const str = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(
            'INSERT INTO baileys_auth (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
            [id, str]
        );
    };

    const readData = async (file) => {
        try {
            const id = fixFileName(file);
            const res = await pool.query('SELECT data FROM baileys_auth WHERE id = $1', [id]);
            if (res.rows.length > 0) {
                // If the data is stored as a stringified JSON in the JSONB column, parse it or if it is an object
                const data = typeof res.rows[0].data === 'string' 
                            ? JSON.parse(res.rows[0].data, BufferJSON.reviver)
                            : JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver);
                return data;
            }
            return null;
        } catch (error) {
            console.error(`Error reading ${file} from DB:`, error);
            return null;
        }
    };

    const removeData = async (file) => {
        try {
            const id = fixFileName(file);
            await pool.query('DELETE FROM baileys_auth WHERE id = $1', [id]);
        } catch (error) {
            console.error(`Error removing ${file} from DB:`, error);
        }
    };

    const creds = (await readData('creds.json')) || initAuthCreds();

    const baseKeyStore = {
        get: async (type, ids) => {
            const data = {};
            await Promise.all(
                ids.map(async (id) => {
                    let value = await readData(`${type}-${id}.json`);
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    data[id] = value;
                })
            );
            return data;
        },
        set: async (data) => {
            const tasks = [];
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    const file = `${category}-${id}.json`;
                    tasks.push(value ? writeData(value, file) : removeData(file));
                }
            }
            await Promise.all(tasks);
        }
    };

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore(baseKeyStore)
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
};
