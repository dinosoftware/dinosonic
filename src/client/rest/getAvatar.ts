import { Context, Hono } from '@hono/hono';
import { config, createResponse, getField, logger, validateAuth } from '../../util.ts';
import * as path from '@std/path';
import { exists } from '@std/fs/exists';

const getAvatar = new Hono();

async function handleGetAvatar(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const username = await getField(c, 'username');
    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });

    const avatarsDir = path.join(config.data_folder, 'avatars');

    for (const ext of ['png', 'gif', 'webp', 'jpg', 'jpeg']) {
        const avatarPath = path.join(avatarsDir, `${username}.${ext}`);
        if (await exists(avatarPath)) {
            try {
                const data = await Deno.readFile(avatarPath);
                const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
                return new Response(data, {
                    headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
                });
            } catch {
                logger.debug(`Failed to read avatar for ${username} with extension ${ext}`);
            }
        }
    }

    return createResponse(c, {}, 'ok');
}

getAvatar.get('/getAvatar', handleGetAvatar);
getAvatar.post('/getAvatar', handleGetAvatar);
getAvatar.get('/getAvatar.view', handleGetAvatar);
getAvatar.post('/getAvatar.view', handleGetAvatar);

export default getAvatar;
