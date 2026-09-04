// PlaylistManager.ts
import { make as PImage, decodeJPEGFromStream, decodePNGFromStream, encodePNGToStream, registerFont } from 'pureimage';
import type { Context as PImageContext } from 'pureimage';
import { assetPath, config, database, logger } from './util.ts';
import { CoverArt, CoverArtSchema, Playlist, PlaylistSchema, Song } from './zod.ts';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { Readable, Writable } from 'node:stream';

const CANVAS_SIZE = 500;

async function decodeCoverArt(coverArtPath: string) {
    const data = await Deno.readFile(coverArtPath);
    const isPNG = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    const isJPEG = data[0] === 0xff && data[1] === 0xd8;

    if (isPNG) return await decodePNGFromStream(Readable.from([data]));
    if (isJPEG) return await decodeJPEGFromStream(Readable.from([data]));

    const ffmpeg = await new Deno.Command(config.transcoding?.ffmpeg_path || 'ffmpeg', {
        args: ['-i', coverArtPath, '-f', 'image2pipe', '-vcodec', 'png', '-'],
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    if (!ffmpeg.success || !ffmpeg.stdout.length) {
        const details = new TextDecoder().decode(ffmpeg.stderr).trim();
        throw new Error(`Unsupported cover format${details ? `: ${details}` : ''}`);
    }

    return await decodePNGFromStream(Readable.from([ffmpeg.stdout]));
}

async function getAverageColor(coverArtPath: string): Promise<[number, number, number]> {
    const img = await decodeCoverArt(coverArtPath);
    const size = 32;
    const canvas = PImage(size, size);
    const stepX = Math.max(1, Math.floor(img.width / size));
    const stepY = Math.max(1, Math.floor(img.height / size));
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const si = ((y * stepY) * img.width + (x * stepX)) * 4;
            const di = (y * size + x) * 4;
            canvas.data[di] = img.data[si];
            canvas.data[di + 1] = img.data[si + 1];
            canvas.data[di + 2] = img.data[si + 2];
            canvas.data[di + 3] = 255;
        }
    }
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < canvas.data.length; i += 4) {
        r += canvas.data[i]; g += canvas.data[i + 1]; b += canvas.data[i + 2]; n++;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function drawPlaylistTitle(ctx: PImageContext, title: string, textColor: string) {
    const maxWidth = 450, maxHeight = 450;
    let fontSize = 64;
    let lines: string[] = [];

    const wrap = (t: string): string[] => {
        const words = t.split(/\s+/);
        const out: string[] = [];
        let line = '';
        for (const w of words) {
            const test = line ? `${line} ${w}` : w;
            const { width } = ctx.measureText(test);
            if (width <= maxWidth) line = test;
            else {
                if (line) out.push(line);
                line = w;
            }
        }
        if (line) out.push(line);
        return out;
    };

    while (fontSize > 10) {
        ctx.font = `${fontSize}px Dinofiles`;
        lines = wrap(title);
        if (lines.length * fontSize * 1.2 <= maxHeight) break;
        fontSize -= 4;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;

    const totalH = lines.length * fontSize * 1.2;
    let y = (CANVAS_SIZE - totalH) / 2 + fontSize / 2;
    for (const line of lines) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillText(line, CANVAS_SIZE / 2 + 2, y + 2);
        ctx.fillStyle = textColor;
        ctx.fillText(line, CANVAS_SIZE / 2, y);
        y += fontSize * 1.2;
    }
}

export async function generatePlaylistCover(playlistId: string): Promise<string | null> {
    try {
        const playlist = (await database.get(['playlists', playlistId])).value as Playlist | null;
        if (!playlist?.entry?.length) {
            logger.debug(`[Cover Art] Playlist ${playlistId} not found or empty; skipping cover generation.`);
            return null;
        }

        const firstTrackId = playlist.entry[0] as string;
        const track = (await database.get(['tracks', firstTrackId])).value as Song | null;
        if (!track?.subsonic.albumId) {
            logger.error(`[Cover Art] Track ${firstTrackId} missing albumId.`);
            return null;
        }

        const coverArtQ = (await database.get(['covers', track.subsonic.albumId])).value as CoverArt | null;
        if (!coverArtQ) {
            logger.error(`[Cover Art] Album ${track.subsonic.albumId} has no cover art.`);
            return null;
        }

        const [r, g, b] = await getAverageColor(coverArtQ.path);
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        const textColor = luminance > 128 ? '#000000' : '#ffffff';

        const img = PImage(CANVAS_SIZE, CANVAS_SIZE);
        const ctx = img.getContext('2d');
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        const fontPath = assetPath('client/public/Dinofiles-font.ttf');
        const font = registerFont(fontPath, 'Dinofiles');
        await font.load();
        drawPlaylistTitle(ctx, playlist.name, textColor);

        const coversDir = join(config.data_folder, 'covers');
        await Deno.mkdir(coversDir, { recursive: true }).catch(() => { });
        const finalPath = join(coversDir, `${playlistId}.png`);

        const chunks: Uint8Array[] = [];
        const writable = new Writable({
            write(chunk, _encoding, callback) {
                chunks.push(chunk);
                callback();
            },
        });
        const done = new Promise<void>((resolve) => writable.on('finish', resolve));
        await encodePNGToStream(img, writable);
        await done;
        await Deno.writeFile(finalPath, new Uint8Array(Buffer.concat(chunks)));

        console.log('[Cover Art] Finished writing:', finalPath);

        return finalPath;
    } catch (err) {
        const message = err instanceof Error ? err.stack || err.message : String(err);
        logger.error(`[Cover Art] Failed to generate cover for ${playlistId}: ${message}`);
        return null;
    }
}

export async function updatePlaylistCover(playlistId: string): Promise<boolean> {
    const playlistEntry = await database.get(['playlists', playlistId]);
    const playlistParse = PlaylistSchema.safeParse(playlistEntry.value);
    if (!playlistParse.success) {
        logger.warn(`[PlaylistManager] Invalid playlist ${playlistId}`);
        return false;
    }

    const playlist = playlistParse.data;
    const coverEntry = await database.get(['covers', playlist.id]);
    const coverParse = CoverArtSchema.safeParse(coverEntry.value);
    const valid = coverParse.success && await exists(coverParse.data.path);

    if (valid) return false;

    const newCoverPath = await generatePlaylistCover(playlist.id);
    if (!newCoverPath) return false;

    const newCover = CoverArtSchema.safeParse({
        id: playlist.id,
        mimeType: 'image/png',
        path: newCoverPath,
    });

    if (!newCover.success) return false;
    await database.set(['covers', playlist.id], newCover.data);
    playlist.coverArt = playlist.id;
    await database.set(['playlists', playlist.id], playlist);

    logger.info(`[PlaylistManager] Generated and saved new cover for "${playlist.name}".`);
    return true;
}
