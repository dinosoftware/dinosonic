import { Context, Hono } from '@hono/hono';
import { config, createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { findSonicPath } from '../../AudioMuse.ts';
import { SongSchema, userData } from '../../zod.ts';

const findSonicPathEndpoint = new Hono();

async function handleFindSonicPath(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    if (!config.audio_similarity?.enabled || !config.audio_similarity.audiomuse_url) {
        return createResponse(c, {}, 'failed', { code: 0, message: 'Sonic similarity is not enabled on this server' });
    }

    const startSongId = await getField(c, 'startSongId');
    const endSongId = await getField(c, 'endSongId');
    const count = parseInt(await getField(c, 'count') || '25');

    if (!startSongId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'startSongId'" });
    if (!endSongId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'endSongId'" });

    const startEntry = await database.get(['tracks', startSongId]);
    if (!startEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'Start song not found' });

    const endEntry = await database.get(['tracks', endSongId]);
    if (!endEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'End song not found' });

    if (startSongId === endSongId) return createResponse(c, {}, 'failed', { code: 0, message: 'Start and end songs cannot be the same' });

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const pathResults = await findSonicPath(startSongId, endSongId, count);

    if (pathResults.length === 0) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'No sonic path found between the selected songs' });
    }

    const sonicMatches = [];

    for (const step of pathResults) {
        const trackEntry = await database.get(['tracks', step.trackId]);
        if (!trackEntry.value) continue;

        const songParse = SongSchema.safeParse(trackEntry.value);
        if (!songParse.success) continue;

        const song = songParse.data;
        const subsonic = { ...song.subsonic };

        const userTrackData = (await database.get(['userData', user.backend.id, 'track', song.subsonic.id])).value as userData | undefined;
        if (userTrackData) {
            if (userTrackData.starred) subsonic.starred = userTrackData.starred.toISOString();
            if (userTrackData.played) subsonic.played = userTrackData.played.toISOString();
            if (userTrackData.playCount) subsonic.playCount = userTrackData.playCount;
            if (userTrackData.userRating) subsonic.userRating = userTrackData.userRating;
        }

        sonicMatches.push({
            entry: subsonic,
            similarity: step.similarity,
        });
    }

    return createResponse(c, {
        sonicMatch: sonicMatches,
    }, 'ok');
}

findSonicPathEndpoint.get('/findSonicPath', handleFindSonicPath);
findSonicPathEndpoint.post('/findSonicPath', handleFindSonicPath);
findSonicPathEndpoint.get('/findSonicPath.view', handleFindSonicPath);
findSonicPathEndpoint.post('/findSonicPath.view', handleFindSonicPath);

export default findSonicPathEndpoint;
