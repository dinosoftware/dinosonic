import { Context, Hono } from '@hono/hono';
import { config, createResponse } from '../../util.ts';

const getOpenSubsonicExtensions = new Hono();

function handlegetOpenSubsonicExtensions(c: Context) {
    const extensions = [
        {
            name: 'formPost',
            versions: [1],
        },
        {
            name: 'songLyrics',
            versions: [1],
        },
        {
            name: 'transcodeOffset',
            versions: [1],
        },
        {
            name: 'indexBasedQueue',
            versions: [1],
        },
        {
            name: 'transcoding',
            versions: [1],
        },
        {
            name: 'apiKeyAuthentication',
            versions: [1],
        },
    ];

    if (config.audio_similarity?.enabled && config.audio_similarity.audiomuse_url) {
        extensions.push({
            name: 'sonicSimilarity',
            versions: [1],
        });
    }

    return createResponse(c, {
        openSubsonicExtensions: extensions,
    }, 'ok');
}

getOpenSubsonicExtensions.get('/getOpenSubsonicExtensions', handlegetOpenSubsonicExtensions);
getOpenSubsonicExtensions.post('/getOpenSubsonicExtensions', handlegetOpenSubsonicExtensions);
getOpenSubsonicExtensions.get('/getOpenSubsonicExtensions.view', handlegetOpenSubsonicExtensions);
getOpenSubsonicExtensions.post('/getOpenSubsonicExtensions.view', handlegetOpenSubsonicExtensions);

export default getOpenSubsonicExtensions;
