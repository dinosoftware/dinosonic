import { Context, Hono } from '@hono/hono';
import { config, createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { getSimilarTracks } from '../../AudioMuse.ts';
import { SongSchema, userData } from '../../zod.ts';

const getSonicSimilarTracks = new Hono();

async function handleGetSonicSimilarTracks(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    if (!config.audio_similarity?.enabled || !config.audio_similarity.audiomuse_url) {
        return createResponse(c, {}, 'failed', { code: 0, message: 'Sonic similarity is not enabled on this server' });
    }

    const id = await getField(c, 'id');
    const count = parseInt(await getField(c, 'count') || '10');

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const trackEntry = await database.get(['tracks', id]);
    if (!trackEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

    const songParse = SongSchema.safeParse(trackEntry.value);
    if (!songParse.success) return createResponse(c, {}, 'failed', { code: 70, message: 'Song data corrupted' });

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const similarResults = await getSimilarTracks(id, count);

    const seedSong = songParse.data;
    const seedSongSubsonic = { ...seedSong.subsonic };

    const seedUserTrackData = (await database.get(['userData', user.backend.id, 'track', seedSong.subsonic.id])).value as userData | undefined;
    if (seedUserTrackData) {
        if (seedUserTrackData.starred) seedSongSubsonic.starred = seedUserTrackData.starred.toISOString();
        if (seedUserTrackData.played) seedSongSubsonic.played = seedUserTrackData.played.toISOString();
        if (seedUserTrackData.playCount) seedSongSubsonic.playCount = seedUserTrackData.playCount;
        if (seedUserTrackData.userRating) seedSongSubsonic.userRating = seedUserTrackData.userRating;
    }

    const sonicMatches = [
        {
            entry: seedSongSubsonic,
            similarity: 1.0,
        },
    ];

    for (const result of similarResults) {
        const similarTrackEntry = await database.get(['tracks', result.trackId]);
        if (!similarTrackEntry.value) continue;

        const similarSongParse = SongSchema.safeParse(similarTrackEntry.value);
        if (!similarSongParse.success) continue;

        const similarSong = similarSongParse.data;
        const similarSubsonic = { ...similarSong.subsonic };

        const similarUserTrackData = (await database.get(['userData', user.backend.id, 'track', similarSong.subsonic.id])).value as
            | userData
            | undefined;
        if (similarUserTrackData) {
            if (similarUserTrackData.starred) similarSubsonic.starred = similarUserTrackData.starred.toISOString();
            if (similarUserTrackData.played) similarSubsonic.played = similarUserTrackData.played.toISOString();
            if (similarUserTrackData.playCount) similarSubsonic.playCount = similarUserTrackData.playCount;
            if (similarUserTrackData.userRating) similarSubsonic.userRating = similarUserTrackData.userRating;
        }

        sonicMatches.push({
            entry: similarSubsonic,
            similarity: result.similarity,
        });
    }

    return createResponse(c, {
        sonicMatch: sonicMatches,
    }, 'ok');
}

getSonicSimilarTracks.get('/getSonicSimilarTracks', handleGetSonicSimilarTracks);
getSonicSimilarTracks.post('/getSonicSimilarTracks', handleGetSonicSimilarTracks);
getSonicSimilarTracks.get('/getSonicSimilarTracks.view', handleGetSonicSimilarTracks);
getSonicSimilarTracks.post('/getSonicSimilarTracks.view', handleGetSonicSimilarTracks);

export default getSonicSimilarTracks;
