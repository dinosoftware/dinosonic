import { stringify } from '@libs/xml';
import { md5 } from '@takker/md5';
import { encodeHex } from '@std/encoding';
import { Context } from '@hono/hono';
import { type Config, Playlist, Share, type SubsonicUser, type User, UserSchema } from './zod.ts';
import * as log from '@std/log';
import { blue, bold, gray, red, yellow } from '@std/fmt/colors';
import * as path from '@std/path';
import { existsSync } from 'node:fs';

const SERVER_NAME = 'Dinosonic';
const API_VERSION = '1.16.1';
export const SERVER_VERSION = '0.8.1';

const CRASH_ON_DEPRECATED_DB_KEY = false;

export let database: Deno.Kv;
export let config: Config;
export let logger = log.getLogger();

/**
 * A map of Subsonic API error codes to their corresponding messages.
 */
export const ERROR_MESSAGES: Record<number, string> = {
    0: 'A generic error.',
    10: 'Required parameter is missing.',
    20: 'Incompatible Subsonic REST protocol version. Client must upgrade.',
    30: 'Incompatible Subsonic REST protocol version. Server must upgrade.',
    40: 'Wrong username or password.',
    41: 'Token authentication not supported for LDAP users.',
    42: 'Provided authentication mechanism not supported.',
    43: 'Multiple conflicting authentication mechanisms provided.',
    44: 'Invalid API key.',
    50: 'User is not authorized for the given operation.',
    60: 'The trial period for the Subsonic server is over. Please upgrade.',
    70: 'The requested data was not found.',
};

/**
 * Generates an MD5 hash for token-based authentication.
 * @param password The user's password.
 * @param salt A random string (salt).
 * @returns The hex-encoded MD5 hash of the password concatenated with the salt.
 */
function generateTokenHash(password: string, salt: string): string {
    return encodeHex(md5(password + salt));
}

/**
 * Formats a log record with a timestamp and color-coded level.
 * @param logRecord The log record to format.
 * @returns A formatted log string.
 */
function logFormatter(logRecord: log.LogRecord): string {
    const timestamp = new Date().toLocaleTimeString();
    let levelColor;
    switch (logRecord.levelName) {
        case 'INFO':
            levelColor = blue;
            break;
        case 'DEBUG':
            levelColor = gray;
            break;
        case 'WARNING':
            levelColor = yellow;
            break;
        case 'ERROR':
            levelColor = red;
            break;
        default:
            levelColor = bold;
    }
    return `${bold(timestamp)} [${levelColor(logRecord.levelName)}] ${logRecord.msg}`;
}

/**
 * Configures the global logger based on the specified log level.
 * @param logLevel The desired log level (e.g., 'INFO', 'DEBUG', 'OFF').
 */
export async function setupLogger(logLevel: string) {
    logLevel = logLevel.toUpperCase();

    if (logLevel === 'OFF') {
        await log.setup({
            handlers: {},
            loggers: {
                default: {
                    level: 'NOTSET',
                    handlers: [],
                },
            },
        });
    } else {
        await log.setup({
            handlers: {
                console: new log.ConsoleHandler(logLevel as log.LevelName, {
                    formatter: logFormatter,
                }),
            },
            loggers: {
                default: {
                    level: logLevel as log.LevelName,
                    handlers: ['console'],
                },
            },
        });
    }

    logger = log.getLogger();
}

/**
 * Checks for an active internet connection by attempting to resolve a domain.
 * @returns A promise that resolves to `true` if the connection is successful, `false` otherwise.
 */
export async function checkInternetConnection(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch('https://dns.google.com/resolve?name=example.com', {
            signal: controller.signal,
        });

        clearTimeout(timeout);
        return response.ok;
    } catch (_) {
        return false;
    }
}

/**
 * Generates a cryptographically random ID string of a specified length.
 * @param length The desired length of the ID. Defaults to 30.
 * @returns A promise that resolves to the generated ID string.
 */
export async function generateId(length = 30): Promise<string> {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);

    const hashBuffer = await crypto.subtle.digest('SHA-256', randomBytes);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const maxStart = hashHex.length - length;
    const start = Math.floor(Math.random() * (maxStart + 1));
    return hashHex.slice(start, start + length);
}

/**
 * Initializes global constants for the database and configuration.
 * @param Database The Deno.Kv instance to use.
 * @param Config The application configuration object.
 * @returns The initialized Deno.Kv instance.
 */
export function setConstants(Database: Deno.Kv, Config: Config) {
    config = Config;
    getTempDir(); // Eagerly create the temp directory on startup
    return database = Database;
}

/**
 * Converts an array of separator characters into a single regular expression.
 * @param separators An array of strings to be used as separators.
 * @returns A RegExp that matches one or more of the specified separators.
 */
export function assetPath(relativePath: string): string {
    return new URL(`src/${relativePath}`, import.meta.url).pathname;
}

export function separatorsToRegex(separators: string[]): RegExp {
    const escaped = separators.map((sep) => `\\${sep}`).join('|');
    return new RegExp(`[${escaped}]+`);
}

/**
 * Retrieves all values for a given field name from a request context.
 * Supports both GET (query parameters) and POST (form body).
 * @param c The Hono context object.
 * @param fieldName The name of the field to retrieve.
 * @returns A promise that resolves to an array of strings or undefined if not found.
 */
export async function getFields(c: Context, fieldName: string): Promise<string[] | undefined> {
    if (c.req.method === 'GET') {
        return c.req.queries(fieldName);
    } else if (c.req.method === 'POST') {
        const contentType = c.req.header('content-type') || '';

        const queryValues = c.req.queries(fieldName);
        if (queryValues && queryValues.length > 0) return queryValues;
        if (contentType.includes('application/json')) return undefined;

        if (contentType.includes('application/x-www-form-urlencoded')) {
            const formData = await c.req.formData();
            const values = formData.getAll(fieldName).map((v) => String(v));
            return values.length > 0 ? values : undefined;
        }

        const body = await c.req.parseBody();
        const values: string[] = [];

        Object.keys(body).forEach((key) => {
            const match = key.match(new RegExp(`^${fieldName}\\[(\\d+)\\]$`));
            if (match) {
                values[parseInt(match[1], 10)] = body[key] as string;
            }
        });

        if (values.length > 0) return values;

        const value = body[fieldName];
        return Array.isArray(value) ? value : value !== undefined ? [value as string] : undefined;
    }
}

/**
 * Retrieves a single value for a given field name from a request context.
 * @param c The Hono context object.
 * @param fieldName The name of the field to retrieve.
 * @returns A promise that resolves to the field's value as a string, or undefined if not found.
 */
export async function getField(c: Context, fieldName: string): Promise<string | undefined> {
    if (c.req.method === 'GET') {
        return c.req.query(fieldName);
    } else if (c.req.method === 'POST') {
        const queryValue = c.req.query(fieldName);
        if (queryValue !== undefined) return queryValue;

        const contentType = c.req.header('content-type') || '';
        if (contentType.includes('application/json')) return undefined;

        const body = await c.req.parseBody();
        return body[fieldName] as string | undefined;
    }
}

/**
 * Parses a time string (e.g., "1d 12h 30m") into milliseconds.
 * @param timeStr The time string to parse. Supported units: s, m, h, d.
 * @returns The total time in milliseconds.
 */
export function parseTimeToMs(timeStr: string): number {
    const timeUnits: Record<string, number> = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
    };

    return timeStr.split(' ').reduce((total, part) => {
        const match = part.match(/(\d+)([smhd])/);
        if (match) {
            const [, num, unit] = match;
            return total + parseInt(num) * timeUnits[unit];
        }
        return total;
    }, 0);
}

/**
 * Gets or creates a singleton temporary directory for the application.
 * @returns A promise that resolves to the path of the temporary directory.
 */
export async function getTempDir(): Promise<string> {
    if (!globalThis.__tmpDir) {
        globalThis.__tmpDir = await Deno.makeTempDir({ prefix: 'dinosonic_' });
    }
    return globalThis.__tmpDir;
}

declare global {
    var __tmpDir: string;
}

/**
 * Registers cleanup handlers to remove the temporary directory on process exit.
 */
export function registerTempDirCleanup() {
    const cleanup = async () => {
        if (globalThis.__tmpDir && existsSync(globalThis.__tmpDir)) {
            try {
                await Deno.remove(globalThis.__tmpDir, { recursive: true });
                console.log('Temporary directory cleaned up:', globalThis.__tmpDir);
            } catch (err) {
                console.warn('Failed to clean up temp dir:', err);
            }
        }
        Deno.exit();
    };

    Deno.addSignalListener('SIGINT', cleanup);
    Deno.addSignalListener('SIGTERM', cleanup);
    addEventListener('unload', () => {
        if (globalThis.__tmpDir && existsSync(globalThis.__tmpDir)) {
            Deno.removeSync(globalThis.__tmpDir, { recursive: true });
        }
    });
}

/**
 * Retrieves a Last.fm session key using a temporary token.
 * @param token The temporary token from Last.fm's auth flow.
 * @returns A promise that resolves to the session key or null if it fails.
 */
export async function getSessionKey(token: string): Promise<string | null> {
    if (config.last_fm?.api_key && config.last_fm?.api_secret) {
        const params = new URLSearchParams({
            api_key: config.last_fm.api_key,
            method: 'auth.getSession',
            token,
        });

        const api_sig = signParams(params, config.last_fm.api_secret);
        params.append('api_sig', api_sig);
        params.append('format', 'json');

        const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`);
        const data = await res.json();
        return data.session?.key || null;
    }

    return null;
}

/**
 * Signs a set of Last.fm API parameters with the API secret.
 * @param params The URLSearchParams to sign.
 * @param apiSecret The Last.fm API secret.
 * @returns The generated MD5 signature string.
 */
export function signParams(params: URLSearchParams, apiSecret: string): string {
    const sortedKeys = [...params.keys()].sort();
    let signatureBase = '';

    for (const key of sortedKeys) {
        if (key !== 'format' && key !== 'api_sig') {
            signatureBase += key + params.get(key);
        }
    }

    signatureBase += apiSecret;

    return encodeHex(md5(signatureBase));
}

/**
 * Ensures that an admin user exists in the database.
 * @description This function checks a flag in the database to see if an admin should exist.
 * If the flag is set, it verifies an admin user is actually present. If the flag is not set,
 * or if the verification fails, it creates a new admin user with credentials from the config
 * and sets the flag.
 */
export async function ensureAdminUserExistsHybrid() {
    const adminSetupFlagKey: Deno.KvKey = ['system', 'initialAdminCreated'];
    const adminSetupFlagEntry = await database.get(adminSetupFlagKey);
    const initialAdminShouldExist = adminSetupFlagEntry.value === true;
    let actualAdminExists = false;

    if (initialAdminShouldExist) {
        logger.info('Initial admin setup flag is present. Verifying actual admin existence...');
        for await (const entry of database.list({ prefix: ['users'] })) {
            const userParseResult = UserSchema.safeParse(entry.value);
            if (userParseResult.success && userParseResult.data.subsonic.adminRole === true) {
                actualAdminExists = true;
                logger.info(`Verified admin user: ${userParseResult.data.subsonic.username}`);
                break;
            }
        }
        if (!actualAdminExists) {
            logger.warn('Admin setup flag was true, but no admin user was found! Recreating.');
        }
    }

    if (!initialAdminShouldExist || !actualAdminExists) {
        logger.info('Creating or recreating admin user.');

        const adminId = await generateId();
        const adminUsername = 'admin';
        const adminPassword = config.default_admin_password;

        const newAdminUser: User = {
            backend: {
                id: adminId,
                username: adminUsername,
                password: await encryptForTokenAuth(adminPassword),
                apiKeys: [],
            },
            subsonic: {
                username: adminUsername,
                adminRole: true,
                scrobblingEnabled: true,
                settingsRole: true,
                downloadRole: true,
                uploadRole: true,
                playlistRole: true,
                coverArtRole: true,
                commentRole: true,
                podcastRole: true,
                streamRole: true,
                jukeboxRole: false,
                shareRole: false,
            },
        };

        const validationResult = UserSchema.safeParse(newAdminUser);
        if (validationResult.success) {
            await database.set(['users', adminId], validationResult.data);
            await database.set(adminSetupFlagKey, true);
            logger.info(`Admin user "${adminUsername}" created successfully.`);
        } else {
            logger.error('Failed to validate new admin user data.', validationResult.error.issues);
        }
    } else {
        logger.info('Admin user verified and exists. No action needed.');
    }
}

let cachedEncryptionKey: CryptoKey | null = null;

/**
 * Derives an AES-GCM CryptoKey from a plaintext seed string via SHA-256.
 */
async function deriveKeyFromSeed(seed: string): Promise<CryptoKey> {
    const seedBytes = new TextEncoder().encode(seed);
    const hash = await crypto.subtle.digest('SHA-256', seedBytes);
    return await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Returns the SHA-256 hex digest of a string. Used to store a fingerprint of
 * the configured seed so we can detect seed changes across restarts without
 * storing the seed itself.
 */
async function seedHash(seed: string): Promise<string> {
    const seedBytes = new TextEncoder().encode(seed);
    const hash = await crypto.subtle.digest('SHA-256', seedBytes);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Imports an AES-GCM CryptoKey directly from a raw base64-encoded key string
 * (the legacy auto-generated database key format).
 */
async function importRawKeyFromBase64(b64: string): Promise<CryptoKey> {
    const keyBuffer = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Returns the active encryption key. Must only be called after `initEncryptionKey`
 * has completed successfully.
 */
export function getEncryptionKey(): CryptoKey {
    if (cachedEncryptionKey) return cachedEncryptionKey;
    throw new Error('Encryption key has not been initialized. Ensure initEncryptionKey() is called on startup.');
}

/**
 * Initializes the encryption key on startup. Resolution order:
 *
 * 1. `encryption_key` in config   — preferred
 * 2. `DINO_ENCRYPTION_KEY` env var — alternative
 * 3. `['system', 'encryptionKey']` in the KV database — DEPRECATED, logs a
 *    prominent warning (or crashes if `CRASH_ON_DEPRECATED_DB_KEY` is true).
 * 4. Nothing found → hard crash; an explicit key is now required.
 *
 * If a configured seed is present AND a legacy database key also exists, the
 * function migrates all user passwords from the old key to the new one and
 * removes the database key entry. If migration of an individual user fails,
 * their password is reset to `config.default_admin_password` encrypted under
 * the new key so the account remains accessible.
 */
export async function initEncryptionKey(): Promise<void> {
    const resolvedSeed = config.encryption_key || null;
    const dbKeyEntry = await database.get<string>(['system', 'encryptionKey']);
    const hasDbKey = dbKeyEntry.value !== null && dbKeyEntry.value !== undefined;

    if (!resolvedSeed && !hasDbKey) {
        throw new Error(
            '[Dinosonic] No encryption key found. ' +
            'Set "encryption_key" in your config file or the DINO_ENCRYPTION_KEY environment variable. ' +
            'The auto-generated database key is deprecated and was not found either.',
        );
    }

    if (!resolvedSeed && hasDbKey) {
        const msg =
            '[Dinosonic] DEPRECATED: Your encryption key is stored in the database ' +
            '(["system","encryptionKey"]). This method is no longer supported and will be ' +
            'removed in a future release. Please set "encryption_key" in your config file or ' +
            'the DINO_ENCRYPTION_KEY environment variable and restart. ' +
            'On next startup with a configured key the database key will be migrated automatically.';

        if (CRASH_ON_DEPRECATED_DB_KEY) {
            throw new Error(msg);
        }

        logger.warn(msg);
        cachedEncryptionKey = await importRawKeyFromBase64(dbKeyEntry.value!);
        logger.info('Encryption key: loaded from deprecated database key. Server will continue, but please migrate.');
        return;
    }

    cachedEncryptionKey = await deriveKeyFromSeed(resolvedSeed!);

    if (!hasDbKey) {
        const storedSeedHashEntry = await database.get<string>(['system', 'encryptionKeySeedHash']);
        if (storedSeedHashEntry.value) {
            const currentHash = await seedHash(resolvedSeed!);
            if (storedSeedHashEntry.value !== currentHash) {
                logger.warn(
                    'Encryption seed has changed and no legacy database key is present for migration. ' +
                    'All user passwords will be reset to the default_admin_password from config.',
                );
                await resetAllPasswords(cachedEncryptionKey);
            } else {
                logger.info('Encryption key: using configured seed (fingerprint matches).');
            }
        } else {
            logger.info('Encryption key: configured seed in use for the first time, storing fingerprint.');
        }

        await database.set(['system', 'encryptionKeySeedHash'], await seedHash(resolvedSeed!));
        return;
    }

    logger.info('Legacy database encryption key found alongside a configured seed. Starting password migration...');

    const oldKey = await importRawKeyFromBase64(dbKeyEntry.value!);
    await migratePasswordsToNewKey(oldKey, cachedEncryptionKey);

    await database.delete(['system', 'encryptionKey']);
    await database.set(['system', 'encryptionKeySeedHash'], await seedHash(resolvedSeed!));
    logger.info('Migration complete. Legacy database key removed.');
}

/**
 * Migrates all user passwords from `oldKey` to `newKey`. If decryption of a
 * user's password fails (e.g. it was already encrypted with a different key),
 * the password is reset to `config.default_admin_password` encrypted under
 * `newKey` so the account remains accessible.
 */
async function migratePasswordsToNewKey(oldKey: CryptoKey, newKey: CryptoKey): Promise<void> {
    let migrated = 0;
    let reset = 0;

    for await (const entry of database.list({ prefix: ['users'] })) {
        const userParse = UserSchema.safeParse(entry.value);
        if (!userParse.success) continue;

        const user = userParse.data;
        let plaintext: string;

        try {
            const combined = Uint8Array.from(atob(user.backend.password), (c) => c.charCodeAt(0));
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, oldKey, ciphertext);
            plaintext = new TextDecoder().decode(decrypted);
        } catch {
            logger.warn(
                `Could not decrypt password for user "${user.subsonic.username}" during migration. ` +
                `Resetting to default_admin_password from config.`,
            );
            plaintext = config.default_admin_password;
            reset++;
        }

        try {
            const newIv = crypto.getRandomValues(new Uint8Array(12));
            const newEncrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: newIv },
                newKey,
                new TextEncoder().encode(plaintext),
            );
            const newCombined = new Uint8Array(newIv.length + newEncrypted.byteLength);
            newCombined.set(newIv, 0);
            newCombined.set(new Uint8Array(newEncrypted), newIv.length);
            user.backend.password = btoa(String.fromCharCode(...newCombined));
            await database.set(entry.key, user);
            migrated++;
        } catch {
            logger.error(`Failed to re-encrypt password for user "${user.subsonic.username}". Entry skipped.`);
        }
    }

    logger.info(`Password migration complete: ${migrated} migrated, ${reset} reset to default.`);
}

/**
 * Re-encrypts all user passwords with `newKey` using `config.default_admin_password`
 * as the plaintext. Used when the seed changes but there is no old key to decrypt from.
 */
async function resetAllPasswords(newKey: CryptoKey): Promise<void> {
    let count = 0;

    for await (const entry of database.list({ prefix: ['users'] })) {
        const userParse = UserSchema.safeParse(entry.value);
        if (!userParse.success) continue;

        const user = userParse.data;
        try {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                newKey,
                new TextEncoder().encode(config.default_admin_password),
            );
            const combined = new Uint8Array(iv.length + encrypted.byteLength);
            combined.set(iv, 0);
            combined.set(new Uint8Array(encrypted), iv.length);
            user.backend.password = btoa(String.fromCharCode(...combined));
            await database.set(entry.key, user);
            count++;
        } catch {
            logger.error(`Failed to reset password for user "${user.subsonic.username}".`);
        }
    }

    logger.info(`Reset ${count} user password(s) to default_admin_password.`);
}

/**
 * Encrypts a password string using AES-GCM.
 * @param password The plaintext password to encrypt.
 * @returns A promise that resolves to a base64 encoded string containing the IV and ciphertext.
 */
export async function encryptForTokenAuth(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getEncryptionKey();
    const encryptedData = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

    const combined = new Uint8Array(iv.length + encryptedData.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encryptedData), iv.length);

    return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a password string that was encrypted with `encryptForTokenAuth`.
 * @param encryptedData The base64 encoded string containing the IV and ciphertext.
 * @returns A promise that resolves to the original plaintext password.
 */
export async function decryptForTokenAuth(encryptedData: string): Promise<string> {
    const combined = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await getEncryptionKey();

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

/**
 * Deletes a user and all of their associated data from the database in a single transaction.
 * @param id The ID of the user to delete.
 */
export async function deleteUserReferences(id: string, username?: string) {
    const txn = database.atomic();

    txn.delete(['users', id]);

    for await (const entry of database.list({ prefix: ['userData', id] })) {
        txn.delete(entry.key);
    }
    for await (const entry of database.list({ prefix: ['nowPlaying'] })) {
        if (entry.key[1] === id) txn.delete(entry.key);
    }
    for await (const entry of database.list({ prefix: ['playlists'] })) {
        const playlist = entry.value as Playlist;
        if (playlist.owner === id) txn.delete(entry.key);
    }
    for await (const entry of database.list({ prefix: ['shares'] })) {
        const share = entry.value as Share;
        if (share.userId === id) txn.delete(entry.key);
    }

    txn.delete(['playQueue', id]);

    await txn.commit();

    if (username) {
        const avatarsDir = path.join(config.data_folder, 'avatars');
        for (const ext of ['jpg', 'png', 'gif', 'webp']) {
            try {
                await Deno.remove(path.join(avatarsDir, `${username}.${ext}`));
            } catch {
                // File doesn't exist
            }
        }
    }
}

/**
 * Converts a hex-encoded string to a UTF-8 string.
 * @param hex The hex string to convert.
 * @returns The decoded string.
 */
export function hexToString(hex: string): string {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    return new TextDecoder().decode(bytes);
}

/**
 * Finds a user in the database by their username (case-insensitive).
 * @param name The username to search for.
 * @returns A promise that resolves to the User object or undefined if not found.
 */
export async function getUserByUsername(name: string): Promise<User | undefined> {
    for await (const entry of database.list({ prefix: ['users'] })) {
        const parsedEntry = UserSchema.safeParse(entry.value as User | null);
        if (parsedEntry.success) {
            const user = parsedEntry.data;
            if (user.backend.username === name.toLowerCase().trim()) return user;
        }
    }
}

/**
 * Finds a user in the database by their API key.
 * @param apiKey The API key to search for.
 * @returns A promise that resolves to the User object or undefined if not found.
 */
export async function getUserByApiKey(apiKey: string): Promise<User | undefined> {
    for await (const entry of database.list({ prefix: ['users'] })) {
        const parsedEntry = UserSchema.safeParse(entry.value as User | null);
        if (parsedEntry.success) {
            const user = parsedEntry.data;
            if (user.backend.apiKeys?.some((k) => k.key === apiKey)) return user;
        }
    }
}

/**
 * Creates a standardized OpenSubsonic response in either JSON or XML format.
 * @param c The Hono context object.
 * @param data The main data payload for the response.
 * @param status The status of the response, 'ok' or 'failed'.
 * @param error An optional error object if the status is 'failed'.
 * @returns A Response object formatted according to the client's request.
 */
export async function createResponse(
    c: Context,
    data: Record<string, unknown> = {},
    status: 'ok' | 'failed' = 'ok',
    error?: { code: number; message: string },
) {
    const format = await getField(c, 'f') || 'xml';
    const responseData = {
        'subsonic-response': {
            ...(format.includes('xml') && { '@xmlns': 'http://subsonic.org/restapi' }),
            status,
            version: API_VERSION,
            type: SERVER_NAME,
            serverVersion: SERVER_VERSION,
            openSubsonic: true,
            ...data,
            ...(error ? { error } : {}),
        },
    };

    if (format.includes('xml')) {
        const xmlResponse = stringify(responseData);
        return c.text(xmlResponse, 200, { 'Content-Type': 'application/xml' });
    }

    return c.json(responseData, 200);
}

/**
 * Validates user authentication from a request context.
 * @description Supports password-based (plain or hex-encoded) and token-based authentication.
 * @param c The Hono context object.
 * @returns On success, a promise that resolves to the user's Subsonic profile and backend ID.
 * On failure, a promise that resolves to a formatted error Response object.
 */
export async function validateAuth(c: Context): Promise<Response | (SubsonicUser & { id: string })> {
    const username = await getField(c, 'u');
    const password = await getField(c, 'p');
    const token = await getField(c, 't');
    const salt = await getField(c, 's');
    const apiKey = await getField(c, 'apiKey');
    const client = await getField(c, 'c');

    if (!client) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'c'" });

    const authMethodsProvided = [
        username ? 1 : 0,
        apiKey ? 1 : 0,
    ].reduce((a, b) => a + b, 0);

    if (authMethodsProvided > 1) return createResponse(c, {}, 'failed', { code: 43, message: ERROR_MESSAGES[43] });

    if (apiKey) {
        const user = await getUserByApiKey(apiKey);
        if (!user) return createResponse(c, {}, 'failed', { code: 44, message: ERROR_MESSAGES[44] });

        // Update last used timestamp
        const keyIndex = user.backend.apiKeys?.findIndex((k) => k.key === apiKey);
        if (keyIndex !== undefined && keyIndex >= 0 && user.backend.apiKeys) {
            user.backend.apiKeys[keyIndex].lastUsed = new Date();
            await database.set(['users', user.backend.id], user);
        }

        return { ...user.subsonic, id: user.backend.id };
    }

    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'u'" });

    const user = await getUserByUsername(username);
    if (!user) return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });

    if (token && salt) {
        const originalPassword = await decryptForTokenAuth(user.backend.password);
        const expectedToken = generateTokenHash(originalPassword, salt);
        if (expectedToken !== token) {
            return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        }
        return { ...user.subsonic, id: user.backend.id };
    }

    if (password) {
        const plainPassword = password.startsWith('enc:') ? hexToString(password.slice(4)) : password;
        const originalPassword = await decryptForTokenAuth(user.backend.password);
        if (originalPassword !== plainPassword) {
            return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        }
        return { ...user.subsonic, id: user.backend.id };
    }

    return createResponse(c, {}, 'failed', { code: 42, message: ERROR_MESSAGES[42] });
}