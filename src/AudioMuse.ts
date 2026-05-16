import { config, logger } from './util.ts';

export interface AudioMuseSimilarTrack {
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

export async function getSimilarTracks(
    trackId: string,
    count: number,
): Promise<Array<{ trackId: string; similarity: number }>> {
    try {
        const response = await request('/api/similar_tracks', {
            item_id: trackId,
            n: count.toString(),
        });

        if (!response.ok) {
            logger.debug(`AudioMuse similar_tracks returned ${response.status}`);
            return [];
        }

        const results = await response.json() as AudioMuseSimilarTrack[];
        if (!Array.isArray(results)) return [];

        return results
            .filter((r) => r.item_id !== trackId)
            .map((r) => ({
                trackId: r.item_id,
                similarity: Math.max(0, 1 - r.distance),
            }));
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
    try {
        const response = await request('/api/find_path', {
            start_song_id: startTrackId,
            end_song_id: endTrackId,
            max_steps: maxSteps.toString(),
        });

        if (!response.ok) {
            logger.debug(`AudioMuse find_path returned ${response.status}`);
            return [];
        }

        const result = await response.json() as AudioMusePathResult;
        if (!result.path || !Array.isArray(result.path)) return [];

        const startDistance = result.path[0]?.distance ?? 0;

        return result.path.map((step) => ({
            trackId: step.item_id,
            similarity: Math.max(0, 1 - Math.abs(step.distance - startDistance)),
        }));
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
