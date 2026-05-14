const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { parseTidalURL, downloadTidalTrack, fetchTidalAPIList } = require('./lib/tidal');
const { parseQobuzURL, downloadQobuzTrack } = require('./lib/qobuz');
const { findQobuzFromTidal } = require('./lib/songlink');
const { embedMetadata, downloadCover, convertToFlac, getFFmpegPath } = require('./lib/metadata');
const { sanitizeFilename, ensureDir, formatSize } = require('./lib/utils');

const app = express();
//const PORT = 3000;
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Downloads directory
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
ensureDir(DOWNLOADS_DIR);

// Active downloads tracker
const downloads = new Map();

// ─── Detect service from URL ────────────────────────────────────────
function detectService(url) {
  if (/tidal\.com|listen\.tidal/i.test(url)) return 'tidal';
  if (/qobuz\.com/i.test(url)) return 'qobuz';
  return null;
}

// ─── API: Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const ffmpeg = getFFmpegPath();
  res.json({
    status: 'ok',
    ffmpeg: ffmpeg ? 'found' : 'not found',
    ffmpegPath: ffmpeg || null,
    downloadsDir: DOWNLOADS_DIR,
  });
});

// ─── API: Resolve URL → track info ─────────────────────────────────
app.post('/api/resolve', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const service = detectService(url);
    if (!service) {
      return res.status(400).json({ error: 'Unsupported URL. Only Tidal and Qobuz links are supported.' });
    }

    let trackId;
    if (service === 'tidal') {
      trackId = parseTidalURL(url);
    } else {
      trackId = parseQobuzURL(url);
    }

    res.json({
      service,
      trackId: String(trackId),
      originalUrl: url,
      message: `${service.charAt(0).toUpperCase() + service.slice(1)} track detected`,
    });
  } catch (err) {
    console.error('[Resolve]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── API: Search Qobuz tracks (Single Result for existing flow) ──────
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query is required (min 2 chars)' });
    }

    const { searchQobuzTracks } = require('./lib/songlink');
    const results = await searchQobuzTracks(q.trim(), 1);

    if (results && results.length > 0) {
      const result = results[0];
      res.json({
        success: true,
        track: {
          id: result.qobuzTrackId,
          title: result.title,
          artist: result.artistName,
          album: result.albumName,
          coverUrl: result.coverUrl,
          service: 'qobuz',
        },
      });
    } else {
      res.json({ success: false, error: 'No tracks found' });
    }
  } catch (err) {
    console.error('[Search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Search Suggestions (Autocomplete) ──────────────────────────
app.get('/api/search/suggestions', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const { searchQobuzTracks } = require('./lib/songlink');
    const results = await searchQobuzTracks(q.trim(), 5);

    if (results && results.length > 0) {
      res.json({ success: true, tracks: results });
    } else {
      res.json({ success: true, tracks: [] });
    }
  } catch (err) {
    console.error('[Search Suggestions]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Start download ───────────────────────────────────────────
app.post('/api/download', async (req, res) => {
  try {
    const { url, quality, searchQuery, searchTrackId, trackTitle, trackArtist } = req.body;

    let service, trackId;

    // Direct Qobuz track ID from search result
    if (searchTrackId) {
      service = 'qobuz';
      trackId = searchTrackId;
    } else if (url) {
      service = detectService(url);
      if (!service) {
        return res.status(400).json({ error: 'Unsupported URL. Paste a Tidal or Qobuz link, or search for a song.' });
      }

      if (service === 'tidal') {
        trackId = parseTidalURL(url);
      } else {
        trackId = parseQobuzURL(url);
      }
    } else {
      return res.status(400).json({ error: 'URL or search query is required' });
    }

    const downloadId = uuidv4();

    // Track download state
    downloads.set(downloadId, {
      id: downloadId,
      service,
      trackId: String(trackId),
      url: url || `qobuz:search:${searchQuery || trackId}`,
      trackTitle: trackTitle || null,
      trackArtist: trackArtist || null,
      status: 'downloading',
      progress: 0,
      startedAt: Date.now(),
      error: null,
      filePath: null,
      fileName: null,
      quality: null,
      size: null,
    });

    // Return immediately with download ID
    res.json({
      id: downloadId,
      downloadId,
      service,
      trackId: String(trackId),
      status: 'downloading',
      message: 'Download started',
    });

    // Process download in background
    processDownload(downloadId, service, trackId, quality || (service === 'qobuz' ? '27' : 'LOSSLESS'))
      .catch(err => {
        console.error(`[Download ${downloadId}] Fatal error:`, err.message);
        const dl = downloads.get(downloadId);
        if (dl) {
          dl.status = 'failed';
          dl.error = err.message;
        }
      });

  } catch (err) {
    console.error('[Download]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── Background download processor ─────────────────────────────────
async function processDownload(downloadId, service, trackId, quality) {
  const dl = downloads.get(downloadId);
  if (!dl) return;

  const onProgress = (progress) => {
    dl.progress = progress.percent || 0;
    dl.downloaded = progress.downloaded || 0;
    dl.total = progress.total || 0;
  };

  try {
    let result;

    if (service === 'tidal') {
      try {
        result = await downloadTidalTrack(trackId, DOWNLOADS_DIR, onProgress);
      } catch (tidalErr) {
        // Tidal failed — try auto-fallback to Qobuz via Songlink
        console.warn(`[Download ${downloadId}] Tidal failed, attempting Qobuz fallback...`);
        dl.status = 'fallback';
        dl.fallbackReason = tidalErr.message;

        const tidalUrl = dl.url || `https://tidal.com/browse/track/${trackId}`;
        const qobuzInfo = await findQobuzFromTidal(tidalUrl);

        if (qobuzInfo && (qobuzInfo.qobuzTrackId || qobuzInfo.qobuzUrl)) {
          const qobuzTrackId = qobuzInfo.qobuzTrackId || parseQobuzURL(qobuzInfo.qobuzUrl);
          console.log(`[Download ${downloadId}] Qobuz fallback: track ${qobuzTrackId} (${qobuzInfo.title} - ${qobuzInfo.artistName})`);
          dl.status = 'downloading';
          dl.fallbackService = 'qobuz';
          dl.qobuzTrackId = qobuzTrackId;
          dl.progress = 0;
          result = await downloadQobuzTrack(qobuzTrackId, DOWNLOADS_DIR, '27', onProgress);
        } else {
          throw new Error(
            'Tidal download failed and no Qobuz equivalent was found. ' +
            'Original error: ' + tidalErr.message
          );
        }
      }

      // Convert M4A to FLAC if needed
      if (result && result.needsConversion) {
        dl.status = 'converting';
        const flacPath = result.filePath.replace(/\.m4a$/, '.flac');
        await convertToFlac(result.filePath, flacPath);
        result.filePath = flacPath;
      }
    } else {
      result = await downloadQobuzTrack(trackId, DOWNLOADS_DIR, quality, onProgress);
    }

    // Verify file exists and has reasonable size
    const stats = fs.statSync(result.filePath);
    if (stats.size < 1024) {
      throw new Error('Downloaded file is too small — likely an error response');
    }

    // Track which ID was actually used for download (in case of fallback)
    const activeTrackId = dl.fallbackService === 'qobuz' ? (dl.qobuzTrackId || trackId) : trackId;
    const activeService = dl.fallbackService || service;

    // Fetch full metadata, download cover, embed tags, and rename
    try {
      const { extractMetadataFromFile, fetchFullMetadata, downloadCover, embedMetadata } = require('./lib/metadata');
      const { sanitizeFilename, getFirstArtist } = require('./lib/utils');
      
      // 1. Fetch full metadata from API
      let fullMeta = await fetchFullMetadata(activeTrackId, activeService, dl.trackTitle, dl.trackArtist);
      
      // 2. Try to get embedded metadata as fallback if full metadata is missing
      if (!fullMeta || (!fullMeta.title && !fullMeta.artist)) {
        const embeddedMeta = await extractMetadataFromFile(result.filePath);
        if (embeddedMeta) {
          fullMeta = { ...fullMeta, title: embeddedMeta.title, artist: embeddedMeta.artist };
        }
      }
      
      // 3. Fallback to basic trackTitle/trackArtist from request
      if (!fullMeta || (!fullMeta.title && !fullMeta.artist)) {
         if (dl.trackTitle) fullMeta = { title: dl.trackTitle, artist: dl.trackArtist };
      }

      // If we have usable metadata, embed it and rename
      if (fullMeta && fullMeta.title) {
        console.log(`[Download ${downloadId}] Found metadata for embedding: ${fullMeta.artist} - ${fullMeta.title}`);
        
        // Download cover if available
        let coverPath = null;
        if (fullMeta.coverUrl) {
          const coverDest = path.join(path.dirname(result.filePath), `cover_${downloadId}.jpg`);
          coverPath = await downloadCover(fullMeta.coverUrl, coverDest);
        }

        // Embed metadata
        const embedSuccess = await embedMetadata(result.filePath, fullMeta, coverPath);
        
        // Cleanup cover
        if (coverPath && fs.existsSync(coverPath)) {
          try { fs.unlinkSync(coverPath); } catch (e) {}
        }

        // Rename file
        const safeArtist = sanitizeFilename(getFirstArtist(fullMeta.artist || 'Unknown Artist'));
        const safeTitle = sanitizeFilename(fullMeta.title);
        const ext = path.extname(result.filePath);
        
        const newFileName = `${safeArtist} - ${safeTitle}${ext}`;
        const newFilePath = path.join(path.dirname(result.filePath), newFileName);
        
        if (result.filePath !== newFilePath && !fs.existsSync(newFilePath)) {
          fs.renameSync(result.filePath, newFilePath);
          result.filePath = newFilePath;
          console.log(`[Download ${downloadId}] Renamed file to: ${newFileName}`);
        }
      } else {
        console.warn(`[Download ${downloadId}] No metadata found. File remains untagged.`);
      }
    } catch (e) {
      console.warn(`[Download ${downloadId}] Metadata processing failed: ${e.message}`);
    }

    // Update download state
    dl.status = 'completed';
    dl.progress = 100;
    dl.filePath = result.filePath;
    dl.fileName = path.basename(result.filePath);
    dl.quality = result.quality;
    dl.size = stats.size;
    dl.sizeFormatted = formatSize(stats.size);
    dl.completedAt = Date.now();
    if (dl.fallbackService) {
      dl.quality = (dl.quality || '') + ' (via Qobuz fallback)';
    }

    console.log(`[Download ${downloadId}] ✓ Completed: ${dl.fileName} (${dl.sizeFormatted})${dl.fallbackService ? ' [Qobuz fallback]' : ''}`);

  } catch (err) {
    dl.status = 'failed';
    dl.error = err.message;
    console.error(`[Download ${downloadId}] ✗ Failed: ${err.message}`);
  }
}

// ─── API: Get download status ──────────────────────────────────────
app.get('/api/status/:id', (req, res) => {
  const dl = downloads.get(req.params.id);
  if (!dl) {
    return res.status(404).json({ error: 'Download not found' });
  }

  res.json({
    id: dl.id,
    service: dl.fallbackService || dl.service,
    trackId: dl.trackId,
    status: dl.status,
    progress: dl.progress,
    error: dl.error,
    fileName: dl.fileName,
    quality: dl.quality,
    size: dl.size,
    sizeFormatted: dl.sizeFormatted,
    startedAt: dl.startedAt,
    completedAt: dl.completedAt,
    fallback: dl.fallbackService ? true : false,
    fallbackReason: dl.fallbackReason || null,
  });
});

// ─── API: Download completed file ──────────────────────────────────
app.get('/api/file/:id', (req, res) => {
  const dl = downloads.get(req.params.id);
  if (!dl) {
    return res.status(404).json({ error: 'Download not found' });
  }

  if (dl.status !== 'completed' || !dl.filePath) {
    return res.status(400).json({ error: 'File not ready yet' });
  }

  if (!fs.existsSync(dl.filePath)) {
    return res.status(404).json({ error: 'File no longer exists on disk' });
  }

  res.download(dl.filePath, dl.fileName, (err) => {
    if (err) {
      console.error(`[Download ${dl.id}] Error sending file: ${err.message}`);
    } else {
      // Clean up the file from the server after successful transfer
      try {
        if (fs.existsSync(dl.filePath)) {
          fs.unlinkSync(dl.filePath);
          console.log(`[Cleanup] Deleted server copy: ${dl.fileName}`);
        }
      } catch (cleanupErr) {
        console.error(`[Cleanup] Failed to delete file: ${cleanupErr.message}`);
      }
    }
  });
});

// ─── API: List recent downloads ────────────────────────────────────
app.get('/api/downloads', (req, res) => {
  const list = [];
  for (const [id, dl] of downloads) {
    list.push({
      id: dl.id,
      service: dl.service,
      trackId: dl.trackId,
      status: dl.status,
      progress: dl.progress,
      fileName: dl.fileName,
      quality: dl.quality,
      sizeFormatted: dl.sizeFormatted,
      startedAt: dl.startedAt,
      completedAt: dl.completedAt,
      error: dl.error,
    });
  }

  // Return newest first
  list.sort((a, b) => b.startedAt - a.startedAt);
  res.json(list);
});

// ─── SPA fallback ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Periodic Cleanup ──────────────────────────────────────────────
// Clean up old files and state every 30 minutes
setInterval(() => {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  
  for (const [id, dl] of downloads.entries()) {
    if ((dl.status === 'completed' || dl.status === 'failed') && dl.completedAt && (now - dl.completedAt > ONE_HOUR)) {
      if (dl.filePath && fs.existsSync(dl.filePath)) {
        try { fs.unlinkSync(dl.filePath); } catch(e) {}
      }
      downloads.delete(id);
    }
  }
}, 30 * 60 * 1000);

// ─── Start server ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n┌──────────────────────────────────────────────┐`);
  console.log(`│  🎵 FLAC Downloader — Running on port ${PORT}     │`);
  console.log(`│  📂 Downloads: ${DOWNLOADS_DIR.substring(0, 28).padEnd(28)} │`);
  console.log(`│  🔧 FFmpeg: ${getFFmpegPath() ? 'Found ✓' : 'Not found ✗ (metadata disabled)'}${' '.repeat(getFFmpegPath() ? 19 : 3)}│`);
  console.log(`│  🌐 Open: http://localhost:${PORT}               │`);
  console.log(`└──────────────────────────────────────────────┘\n`);

  // Prime Tidal API list on startup
  fetchTidalAPIList().catch(err => {
    console.warn('[Startup] Failed to prime Tidal API list:', err.message);
  });
});
