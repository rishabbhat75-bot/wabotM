import pkg from '@whiskeysockets/baileys';
const { initAuthCreds, BufferJSON, proto } = pkg;
import pg from 'pg';

export const usePostgresAuthState = async (dbUrl) => {
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

    return {
        state: {
            creds,
            keys: {
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
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
};
