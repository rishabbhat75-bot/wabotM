import pkg from '@whiskeysockets/baileys';
const { useMultiFileAuthState } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';
import { usePostgresAuthState } from './pg-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_info');

export async function getAuthState() {
    if (process.env.DATABASE_URL) {
        console.log(`📂 Using PostgreSQL database for auth state...`);
        const { state, saveCreds } = await usePostgresAuthState(process.env.DATABASE_URL);
        return { state, saveCreds };
    } else {
        console.log(`📂 Using local auth directory: ${AUTH_DIR}`);
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        return { state, saveCreds };
    }
}
