import { config, database, logger } from './util.ts';
import { SongSchema } from './zod.ts';

export interface AudioMuseTrack {
    item_id: string;
    title: string;
    author: string;
    album: string;
    distance: number;
}

export interface AudioMusePathResult {
    path: AudioMusePathTrack[];
    total_distance: number;
}

export interface AudioMusePathTrack {
    item_id: string;
    title: string;
    author: string;
    album: string;
    distance: number;
}

export interface AudioMuseTaskStatus {
    task_id: string;
    state: string;
    status_message: string;
    progress: number;
    details: Record<string, unknown>;
    task_type_from_db: string | null;
    running_time_seconds: number;
}

function getBaseUrl(): string {
    const url = config.audio_similarity?.audiomuse_url;
    if (!url) throw new Error('AudioMuse URL is not configured');
    return url.replace(/\/+$/, '');
}

function getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    const token = config.audio_similarity?.api_token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

async function request(path: string, params?: Record<string, string>): Promise<Response> {
    const url = new URL(path, getBaseUrl());
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
    }

    const response = await fetch(url.toString(), {
        headers: getAuthHeaders(),
    });

    return response;
}

async function resolveItemIdByPath(trackPath: string, songTitle?: string, songArtist?: string): Promise<string | null> {
    const baseUrl = getBaseUrl();
    const searchUrl = new URL('/api/search_tracks', baseUrl);
    const fileName = trackPath.split('/').pop() || '';
    const titleGuess = fileName.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]*/, '').replace(/[-_]/g, ' ').trim();

    if (titleGuess.length < 3) return null;

    try {
        const response = await fetch(
            `${searchUrl.toString()}?search_query=${encodeURIComponent(titleGuess)}`,
            { headers: getAuthHeaders() },
        );

        if (!response.ok) return null;

        const results = await response.json() as Array<{ item_id: string; title: string; author: string; album: string }>;
        if (!Array.isArray(results) || results.length === 0) return null;

        if (songTitle && songArtist) {
            for (const result of results) {
                const titleMatch = result.title.toLowerCase().trim() === songTitle.toLowerCase().trim();
                const artistMatch = result.author.toLowerCase().trim() === songArtist.toLowerCase().trim();

                if (titleMatch && artistMatch) {
                    return result.item_id;
                }
            }
        }

        return results[0].item_id;
    } catch (error) {
        logger.debug(`AudioMuse track search failed for "${trackPath}": ${error}`);
        return null;
    }
}

async function resolveItemId(trackId: string): Promise<string | null> {
    const trackEntry = await database.get(['tracks', trackId]);
    if (!trackEntry.value) return null;

    const songParse = SongSchema.safeParse(trackEntry.value);
    if (!songParse.success) return null;

    const song = songParse.data;
    const filePath = song.subsonic.path;

    return await resolveItemIdByPath(filePath, song.subsonic.title, song.subsonic.artist);
}

async function resolveTrackIdByItemId(itemId: string): Promise<string | null> {
    const baseUrl = getBaseUrl();
    const trackUrl = new URL('/api/track', baseUrl);
    trackUrl.searchParams.set('item_id', itemId);

    try {
        const response = await fetch(trackUrl.toString(), {
            headers: getAuthHeaders(),
        });

        if (!response.ok) return null;

        const trackInfo = await response.json() as { item_id: string; title: string; author: string; album: string };
        if (!trackInfo.title) return null;

        for await (const entry of database.list({ prefix: ['tracks'] })) {
            const songParse = SongSchema.safeParse(entry.value);
            if (!songParse.success) continue;

            const song = songParse.data;
            const titleMatch = song.subsonic.title.toLowerCase().trim() === trackInfo.title.toLowerCase().trim();
            const artistMatch = song.subsonic.artist.toLowerCase().trim() === trackInfo.author.toLowerCase().trim();

            if (titleMatch && artistMatch) {
                return song.subsonic.id;
            }
        }

        return null;
    } catch (error) {
        logger.debug(`AudioMuse track lookup failed for item_id "${itemId}": ${error}`);
        return null;
    }
}

export async function getSimilarTracks(
    trackId: string,
    count: number,
): Promise<Array<{ trackId: string; similarity: number }>> {
    const itemId = await resolveItemId(trackId);
    if (!itemId) {
        logger.debug(`AudioMuse: could not resolve Dinosonic track ${trackId} to AudioMuse item`);
        return [];
    }

    try {
        const response = await request('/api/similar_tracks', {
            item_id: itemId,
            n: count.toString(),
        });

        if (!response.ok) {
            logger.debug(`AudioMuse similar_tracks returned ${response.status}`);
            return [];
        }

        const results = await response.json() as AudioMuseTrack[];
        if (!Array.isArray(results)) return [];

        const resolved: Array<{ trackId: string; similarity: number }> = [];

        for (const result of results) {
            const resolvedTrackId = await resolveTrackIdByItemId(result.item_id);
            if (resolvedTrackId && resolvedTrackId !== trackId) {
                const similarity = Math.max(0, 1 - result.distance);
                resolved.push({ trackId: resolvedTrackId, similarity });
            }
        }

        return resolved;
    } catch (error) {
        logger.debug(`AudioMuse getSimilarTracks failed: ${error}`);
        return [];
    }
}

export async function findSonicPath(
    startTrackId: string,
    endTrackId: string,
    maxSteps: number,
): Promise<Array<{ trackId: string; similarity: number }>> {
    const startItemId = await resolveItemId(startTrackId);
    const endItemId = await resolveItemId(endTrackId);

    if (!startItemId || !endItemId) {
        logger.debug(`AudioMuse: could not resolve start/end track to AudioMuse items`);
        return [];
    }

    try {
        const response = await request('/api/find_path', {
            start_song_id: startItemId,
            end_song_id: endItemId,
            max_steps: maxSteps.toString(),
        });

        if (!response.ok) {
            logger.debug(`AudioMuse find_path returned ${response.status}`);
            return [];
        }

        const result = await response.json() as AudioMusePathResult;
        if (!result.path || !Array.isArray(result.path)) return [];

        const startDistance = result.path[0]?.distance ?? 0;
        const resolved: Array<{ trackId: string; similarity: number }> = [];

        for (const step of result.path) {
            const resolvedTrackId = await resolveTrackIdByItemId(step.item_id);
            if (resolvedTrackId) {
                const similarity = Math.max(0, 1 - Math.abs(step.distance - startDistance));
                resolved.push({ trackId: resolvedTrackId, similarity });
            }
        }

        return resolved;
    } catch (error) {
        logger.debug(`AudioMuse findSonicPath failed: ${error}`);
        return [];
    }
}

export async function startAnalysis(): Promise<string | null> {
    try {
        const response = await fetch(`${getBaseUrl()}/api/last_task`, {
            headers: getAuthHeaders(),
        });

        if (response.ok) {
            const task = await response.json() as AudioMuseTaskStatus;
            if (task.state && !['SUCCESS', 'FAILURE', 'REVOKED', 'NO_PREVIOUS_MAIN_TASK'].includes(task.state)) {
                logger.info(`AudioMuse analysis already in progress: ${task.task_id}`);
                return task.task_id;
            }
        }
    } catch {
        // Continue to start analysis
    }

    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/analysis`, {
            headers: { ...getAuthHeaders(), 'Accept': 'text/html' },
        });

        if (!response.ok) {
            logger.error(`AudioMuse startAnalysis returned ${response.status}`);
            return null;
        }

        return 'analysis_triggered';
    } catch (error) {
        logger.error(`AudioMuse startAnalysis failed: ${error}`);
        return null;
    }
}

export async function getAnalysisStatus(): Promise<AudioMuseTaskStatus | null> {
    try {
        const response = await fetch(`${getBaseUrl()}/api/last_task`, {
            headers: getAuthHeaders(),
        });

        if (!response.ok) return null;

        return await response.json() as AudioMuseTaskStatus;
    } catch (error) {
        logger.debug(`AudioMuse getAnalysisStatus failed: ${error}`);
        return null;
    }
}

export async function healthCheck(): Promise<boolean> {
    try {
        const response = await fetch(`${getBaseUrl()}/api/health`, {
            headers: getAuthHeaders(),
            signal: AbortSignal.timeout(5000),
        });
        return response.ok;
    } catch {
        return false;
    }
}
