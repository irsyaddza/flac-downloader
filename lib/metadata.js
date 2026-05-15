const { createHttpClient, downloadFile } = require('./utils');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Find ffmpeg in common locations
 * Prioritizes ffmpeg-static npm package, then system-level installs
 */
function findFFmpeg() {
  // Try ffmpeg-static npm package first
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      console.log(`[FFmpeg] Found via ffmpeg-static: ${ffmpegStatic}`);
      return ffmpegStatic;
    }
  } catch (e) {
    // ffmpeg-static not installed, try system paths
  }

  const candidates = [
    'ffmpeg', // PATH
    path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\laragon\\bin\\ffmpeg\\ffmpeg.exe',
  ];

  for (const candidate of candidates) {
    try {
      require('child_process').execFileSync(candidate, ['-version'], { 
        stdio: 'pipe',
        timeout: 5000 
      });
      return candidate;
    } catch (e) {
      continue;
    }
  }

  return null;
}

let _ffmpegPath = null;

function getFFmpegPath() {
  if (_ffmpegPath) return _ffmpegPath;
  _ffmpegPath = findFFmpeg();
  return _ffmpegPath;
}

/**
 * Download cover art from URL
 */
async function downloadCover(coverUrl, outputPath) {
  if (!coverUrl) return null;

  try {
    const result = await downloadFile(coverUrl, outputPath);
    return result.path;
  } catch (err) {
    console.error(`[Metadata] Failed to download cover: ${err.message}`);
    return null;
  }
}

/**
 * Embed metadata into a FLAC file using ffmpeg
 */
async function embedMetadata(filePath, metadata, coverPath) {
  const ffmpeg = getFFmpegPath();
  if (!ffmpeg) {
    console.warn('[Metadata] FFmpeg not found — skipping metadata embedding');
    return false;
  }

  const tempOutput = filePath + '.tmp.flac';

  const args = ['-y', '-i', filePath];

  // Add cover art if available
  if (coverPath && fs.existsSync(coverPath)) {
    args.push('-i', coverPath);
  }

  args.push('-map', '0:a');

  if (coverPath && fs.existsSync(coverPath)) {
    args.push('-map', '1:v');
    args.push('-c:v', 'copy');
    args.push('-disposition:v:0', 'attached_pic');
  }

  args.push('-c:a', 'copy');

  // Metadata tags
  const metaTags = {
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    album_artist: metadata.albumArtist,
    date: metadata.date,
    track: metadata.trackNumber ? String(metadata.trackNumber) : undefined,
    disc: metadata.discNumber ? String(metadata.discNumber) : undefined,
    comment: metadata.comment,
    copyright: metadata.copyright,
    publisher: metadata.publisher,
    composer: metadata.composer,
    genre: metadata.genre,
    ISRC: metadata.isrc,
    // Lyrics tags (Vorbis comments standard)
    LYRICS: metadata.syncedLyrics || undefined,
    UNSYNCEDLYRICS: metadata.plainLyrics || undefined,
  };

  for (const [key, value] of Object.entries(metaTags)) {
    if (value) {
      args.push('-metadata', `${key}=${value}`);
    }
  }

  args.push(tempOutput);

  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[Metadata] ffmpeg error: ${stderr}`);
        // Cleanup temp file
        try { fs.unlinkSync(tempOutput); } catch (e) {}
        reject(new Error(`Metadata embedding failed: ${err.message}`));
        return;
      }

      // Replace original with tagged version
      try {
        fs.unlinkSync(filePath);
        fs.renameSync(tempOutput, filePath);
        console.log('[Metadata] Metadata embedded successfully');
        resolve(true);
      } catch (renameErr) {
        reject(new Error(`Failed to finalize file: ${renameErr.message}`));
      }
    });
  });
}

/**
 * Convert M4A to FLAC using ffmpeg
 */
async function convertToFlac(inputPath, outputPath) {
  const ffmpeg = getFFmpegPath();
  if (!ffmpeg) {
    console.warn('[Convert] FFmpeg not found — cannot convert to FLAC');
    return inputPath; // Return original file
  }

  const args = ['-y', '-i', inputPath, '-vn', '-c:a', 'flac', outputPath];

  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[Convert] ffmpeg error: ${stderr}`);
        reject(new Error(`Conversion failed: ${err.message}`));
        return;
      }

      // Remove original M4A
      try { fs.unlinkSync(inputPath); } catch (e) {}
      console.log('[Convert] Converted to FLAC successfully');
      resolve(outputPath);
    });
  });
}

module.exports = {
  findFFmpeg,
  getFFmpegPath,
  downloadCover,
  embedMetadata,
  convertToFlac,
  extractMetadataFromFile,
};

/**
 * Fetch complete metadata (title, artist, album, coverUrl) for a track
 */
async function fetchFullMetadata(trackId, service, fallbackTitle, fallbackArtist) {
  try {
    const { createHttpClient } = require('./utils');
    const client = createHttpClient(15000);
    
    if (service === 'tidal') {
      const { getDebugKey } = require('./songlink');
      const debugKey = getDebugKey ? getDebugKey() : null;
      if (!debugKey) return null;
      
      const response = await client.get(`https://www.musicdl.me/api/tidal/track/${trackId}`, {
        headers: { 'X-Debug-Key': debugKey }
      });
      
      if (response.data && response.data.track) {
        const t = response.data.track;
        return {
          title: t.title,
          artist: t.artist?.name || t.artist,
          album: t.album,
          trackNumber: t.trackNumber,
          isrc: t.isrc,
          coverUrl: t.coverUrl,
          date: t.releaseDate
        };
      }
    } else if (service === 'qobuz') {
      // For Qobuz, if we have fallback title/artist (from search), we can query the search API to get full album info
      if (fallbackTitle && fallbackArtist) {
        const { searchQobuzTrack } = require('./songlink');
        const searchResult = await searchQobuzTrack(fallbackTitle, fallbackArtist);
        if (searchResult) {
          return {
            title: searchResult.title || fallbackTitle,
            artist: searchResult.artistName || fallbackArtist,
            album: searchResult.albumName,
            coverUrl: searchResult.coverUrl,
            isrc: searchResult.isrc
          };
        }
      }
      return { title: fallbackTitle, artist: fallbackArtist };
    }
  } catch (err) {
    console.error(`[Metadata] Failed to fetch full metadata for ${service} track ${trackId}:`, err.message);
  }
  return null;
}

module.exports.fetchFullMetadata = fetchFullMetadata;

/**
 * Extract title and artist from an audio file using ffprobe/ffmpeg
 */
async function extractMetadataFromFile(filePath) {
  const ffmpeg = getFFmpegPath();
  if (!ffmpeg) return null;

  // use ffprobe if available in the same dir
  const ffprobePath = ffmpeg.replace('ffmpeg.exe', 'ffprobe.exe').replace('ffmpeg', 'ffprobe');
  const probeExec = fs.existsSync(ffprobePath) ? ffprobePath : ffmpeg;
  
  return new Promise((resolve) => {
    let args = [];
    if (probeExec.includes('ffprobe')) {
      args = ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath];
    } else {
      // Use ffmpeg if ffprobe isn't available
      args = ['-i', filePath, '-f', 'ffmetadata', '-'];
    }

    execFile(probeExec, args, { timeout: 10000 }, (err, stdout, stderr) => {
      try {
        if (probeExec.includes('ffprobe')) {
          const data = JSON.parse(stdout);
          const tags = data.format?.tags || {};
          // Tags can be uppercase or lowercase depending on the format
          const title = tags.title || tags.TITLE;
          const artist = tags.artist || tags.ARTIST || tags.performer || tags.PERFORMER;
          resolve(title && artist ? { title, artist } : null);
        } else {
          // Parse ffmpeg stderr/stdout
          const output = stdout + '\n' + stderr;
          const titleMatch = output.match(/title\s*:\s*(.+)/i);
          const artistMatch = output.match(/artist\s*:\s*(.+)|performer\s*:\s*(.+)/i);
          
          if (titleMatch && artistMatch) {
            resolve({
              title: titleMatch[1].trim(),
              artist: (artistMatch[1] || artistMatch[2]).trim()
            });
          } else {
            resolve(null);
          }
        }
      } catch (e) {
        resolve(null);
      }
    });
  });
}

module.exports.extractMetadataFromFile = extractMetadataFromFile;
