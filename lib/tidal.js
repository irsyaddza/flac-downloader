const { createHttpClient, downloadFile, sanitizeFilename } = require('./utils');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TIDAL_API_GIST_URL = 'https://gist.githubusercontent.com/afkarxyz/2ce772b943321b9448b454f39403ce25/raw';

// MusicDL API for Tidal (uses debug key auth like Qobuz)
const TIDAL_MUSICDL_API_URL = 'https://www.musicdl.me/api/tidal/download';

// Fallback API endpoints (from SpotiFLAC community) when gist is unavailable
const FALLBACK_TIDAL_APIS = [
  'https://tidal.401658.xyz',
  'https://tidal-api.goofy.workers.dev',
  'https://tidal.nxvtf.org',
];

// Debug key seed parts (shared with Qobuz - from SpotiFLAC source)
const DEBUG_KEY_SEED_PARTS = [
  Buffer.from([0x73, 0x70, 0x6f, 0x74, 0x69, 0x66]),
  Buffer.from([0x6c, 0x61, 0x63, 0x3a, 0x71, 0x6f]),
  Buffer.from([0x62, 0x75, 0x7a, 0x3a, 0x6d, 0x75, 0x73, 0x69, 0x63, 0x64, 0x6c, 0x3a, 0x76, 0x31]),
];
const DEBUG_KEY_AAD = Buffer.from([
  0x71, 0x6f, 0x62, 0x75, 0x7a, 0x7c, 0x6d, 0x75, 0x73, 0x69, 0x63, 0x64,
  0x6c, 0x7c, 0x64, 0x65, 0x62, 0x75, 0x67, 0x7c, 0x76, 0x31,
]);
const DEBUG_KEY_NONCE = Buffer.from([
  0x91, 0x2a, 0x5c, 0x77, 0x0f, 0x33, 0xa8, 0x14, 0x62, 0x9d, 0xce, 0x41,
]);
const DEBUG_KEY_CIPHERTEXT = Buffer.from([
  0xf3, 0x4a, 0x83, 0x45, 0x24, 0xb6, 0x22, 0xaf, 0xd6, 0xc3, 0x6e, 0x2d,
  0x56, 0xd1, 0xbb, 0x0b, 0xe9, 0x1b, 0x4f, 0x1c, 0x5f, 0x41, 0x55, 0xc2,
  0xc6, 0xdf, 0xad, 0x21, 0x58, 0xfe, 0xd5, 0xb8, 0x2d, 0x29, 0xf9, 0x9e,
  0x6f, 0xd6,
]);
const DEBUG_KEY_TAG = Buffer.from([
  0x69, 0x0c, 0x42, 0x70, 0x14, 0x83, 0xff, 0x14, 0xc8, 0xbe, 0x17, 0x00,
  0x69, 0xb1, 0xfe, 0xbb,
]);

let _debugKey = null;

/**
 * Decrypt the MusicDL debug key
 */
function getDebugKey() {
  if (_debugKey) return _debugKey;

  const hasher = crypto.createHash('sha256');
  for (const part of DEBUG_KEY_SEED_PARTS) {
    hasher.update(part);
  }
  const key = hasher.digest();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, DEBUG_KEY_NONCE);
  decipher.setAAD(DEBUG_KEY_AAD);
  decipher.setAuthTag(DEBUG_KEY_TAG);

  const decrypted = Buffer.concat([
    decipher.update(DEBUG_KEY_CIPHERTEXT),
    decipher.final(),
  ]);

  _debugKey = decrypted.toString('utf-8');
  return _debugKey;
}

let cachedAPIList = [];
let lastFetchTime = 0;
const CACHE_TTL = 600000; // 10 minutes

/**
 * Parse a Tidal URL to extract the track ID
 * Supports: https://tidal.com/browse/track/123456, https://listen.tidal.com/track/123456
 */
function parseTidalURL(url) {
  const match = url.match(/\/track\/(\d+)/);
  if (!match) {
    throw new Error('Invalid Tidal URL. Expected format: https://tidal.com/browse/track/{id}');
  }
  return parseInt(match[1], 10);
}

/**
 * Fetch the rotating Tidal API endpoint list from the gist
 */
async function fetchTidalAPIList() {
  const now = Date.now();
  if (cachedAPIList.length > 0 && (now - lastFetchTime) < CACHE_TTL) {
    return cachedAPIList;
  }

  try {
    const client = createHttpClient(12000);
    const response = await client.get(TIDAL_API_GIST_URL);
    const urls = response.data;

    if (Array.isArray(urls) && urls.length > 0) {
      cachedAPIList = urls.map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
      lastFetchTime = now;
      console.log(`[Tidal] Fetched ${cachedAPIList.length} API endpoints`);
      return cachedAPIList;
    }
  } catch (err) {
    console.error(`[Tidal] Failed to fetch API list: ${err.message}`);
  }

  if (cachedAPIList.length > 0) return cachedAPIList;
  
  // Use hardcoded fallback APIs
  console.log('[Tidal] Using fallback API endpoints');
  cachedAPIList = [...FALLBACK_TIDAL_APIS];
  lastFetchTime = now;
  return cachedAPIList;
}

/**
 * Try to download from MusicDL Tidal API (uses debug key auth)
 */
async function downloadFromMusicDL(trackId) {
  const client = createHttpClient(30000);
  const debugKey = getDebugKey();

  console.log(`[Tidal] Trying MusicDL API for track ${trackId}...`);

  const response = await client.post(TIDAL_MUSICDL_API_URL, {
    id: String(trackId),
    quality: 'LOSSLESS',
  }, {
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Key': debugKey,
    },
  });

  const body = response.data;

  if (!body.success) {
    throw new Error(body.error || body.message || 'MusicDL Tidal reported failure');
  }

  if (body.download_url) {
    return { type: 'direct', url: body.download_url, quality: 'LOSSLESS', provider: 'musicdl' };
  }

  // Handle manifest response from musicdl
  if (body.manifest) {
    return {
      type: 'manifest',
      manifest: body.manifest,
      quality: body.audioQuality || 'LOSSLESS',
      bitDepth: body.bitDepth,
      sampleRate: body.sampleRate,
      provider: 'musicdl',
    };
  }

  throw new Error('MusicDL did not return a download URL or manifest');
}

/**
 * Try to get track info from Tidal by hitting the API endpoint
 */
async function getTidalTrackInfo(trackId, apiUrl) {
  const client = createHttpClient(10000);
  const url = `${apiUrl}/track/?id=${trackId}&quality=LOSSLESS`;
  console.log(`[Tidal] Trying API: ${url}`);

  const response = await client.get(url);
  const body = response.data;

  // V2 API response with manifest
  if (body && body.data && body.data.manifest) {
    console.log('[Tidal] Got v2 manifest response');
    return {
      type: 'manifest',
      manifest: body.data.manifest,
      quality: body.data.audioQuality || 'LOSSLESS',
      bitDepth: body.data.bitDepth,
      sampleRate: body.data.sampleRate,
    };
  }

  // V1 API response (array of URLs)
  if (Array.isArray(body)) {
    for (const item of body) {
      if (item.OriginalTrackUrl) {
        console.log('[Tidal] Got direct URL response');
        return {
          type: 'direct',
          url: item.OriginalTrackUrl,
          quality: 'LOSSLESS',
        };
      }
    }
  }

  // Direct URL in body
  if (body && body.url) {
    return { type: 'direct', url: body.url, quality: 'LOSSLESS' };
  }

  throw new Error('No download URL found in Tidal API response');
}

/**
 * Parse a Base64-encoded Tidal manifest to extract download URLs
 */
function parseManifest(manifestB64) {
  const manifestStr = Buffer.from(manifestB64, 'base64').toString('utf-8');

  // BTS JSON manifest
  if (manifestStr.trim().startsWith('{')) {
    const bts = JSON.parse(manifestStr);
    if (bts.urls && bts.urls.length > 0) {
      return {
        type: bts.mimeType && bts.mimeType.includes('flac') ? 'flac' : 'other',
        mimeType: bts.mimeType || '',
        codecs: bts.codecs || '',
        urls: bts.urls,
        isDirect: true,
      };
    }
    throw new Error('BTS manifest has no URLs');
  }

  // DASH XML manifest — extract segment URLs
  // Simple regex-based parsing
  const initMatch = manifestStr.match(/initialization="([^"]+)"/);
  const mediaMatch = manifestStr.match(/media="([^"]+)"/);
  
  if (!initMatch || !mediaMatch) {
    throw new Error('Could not parse DASH manifest');
  }

  const initUrl = initMatch[1].replace(/&amp;/g, '&');
  const mediaTemplate = mediaMatch[1].replace(/&amp;/g, '&');

  // Count segments from SegmentTimeline
  const segmentMatches = [...manifestStr.matchAll(/<S\s+d="\d+"(?:\s+r="(\d+)")?/g)];
  let segmentCount = 0;
  for (const seg of segmentMatches) {
    const repeat = seg[1] ? parseInt(seg[1], 10) : 0;
    segmentCount += repeat + 1;
  }

  if (segmentCount === 0) segmentCount = 1;

  const mediaUrls = [];
  for (let i = 1; i <= segmentCount; i++) {
    mediaUrls.push(mediaTemplate.replace('$Number$', String(i)));
  }

  return {
    type: 'dash',
    initUrl,
    mediaUrls,
    isDirect: false,
  };
}

/**
 * Process a track info result (download the actual file)
 * Shared helper for both MusicDL and rotating API providers
 */
async function processTrackInfo(info, trackId, outputDir, onProgress, providerName) {
  const filename = `tidal_${trackId}.flac`;
  const outputPath = path.join(outputDir, filename);

  if (info.type === 'direct') {
    console.log(`[Tidal] Downloading direct FLAC from ${providerName}: ${info.url.substring(0, 80)}...`);
    const result = await downloadFile(info.url, outputPath, onProgress);
    return {
      filePath: result.path,
      quality: info.quality || 'LOSSLESS',
      size: result.size,
      sizeFormatted: result.sizeFormatted,
      apiUsed: providerName,
    };
  }

  if (info.type === 'manifest') {
    const manifest = parseManifest(info.manifest);

    if (manifest.isDirect && manifest.urls && manifest.urls.length > 0) {
      const directUrl = manifest.urls[0];
      const isFlac = manifest.mimeType && manifest.mimeType.includes('flac');
      const ext = isFlac ? '.flac' : '.m4a';
      const tempPath = path.join(outputDir, `tidal_${trackId}${ext}`);

      console.log(`[Tidal] Downloading from BTS manifest (${manifest.mimeType}) via ${providerName}...`);
      const result = await downloadFile(directUrl, tempPath, onProgress);

      return {
        filePath: result.path,
        quality: info.quality || 'LOSSLESS',
        bitDepth: info.bitDepth,
        sampleRate: info.sampleRate,
        size: result.size,
        sizeFormatted: result.sizeFormatted,
        apiUsed: providerName,
        needsConversion: !isFlac,
      };
    }

    if (manifest.type === 'dash') {
      console.log(`[Tidal] Downloading DASH segments (${manifest.mediaUrls.length} segments) via ${providerName}...`);
      const tempPath = path.join(outputDir, `tidal_${trackId}.m4a`);
      const client = createHttpClient(120000);

      const writer = fs.createWriteStream(tempPath);
      let totalDownloaded = 0;

      const initResp = await client.get(manifest.initUrl, { responseType: 'stream' });
      await new Promise((resolve, reject) => {
        initResp.data.pipe(writer, { end: false });
        initResp.data.on('end', resolve);
        initResp.data.on('error', reject);
      });

      for (let i = 0; i < manifest.mediaUrls.length; i++) {
        const segResp = await client.get(manifest.mediaUrls[i], { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          segResp.data.on('data', (chunk) => {
            totalDownloaded += chunk.length;
            if (onProgress) {
              onProgress({
                downloaded: totalDownloaded,
                total: 0,
                percent: Math.round(((i + 1) / manifest.mediaUrls.length) * 100),
                segment: i + 1,
                totalSegments: manifest.mediaUrls.length,
              });
            }
          });
          segResp.data.pipe(writer, { end: false });
          segResp.data.on('end', resolve);
          segResp.data.on('error', reject);
        });
      }

      writer.end();
      await new Promise(resolve => writer.on('finish', resolve));

      return {
        filePath: tempPath,
        quality: info.quality || 'LOSSLESS',
        bitDepth: info.bitDepth,
        sampleRate: info.sampleRate,
        size: totalDownloaded,
        sizeFormatted: require('./utils').formatSize(totalDownloaded),
        apiUsed: providerName,
        needsConversion: true,
      };
    }
  }

  throw new Error(`Unsupported track info type: ${info.type}`);
}

/**
 * Download a Tidal track to disk.
 * Strategy: Try MusicDL first, then rotating hifi-api endpoints.
 * Returns: { filePath, quality, size }
 */
async function downloadTidalTrack(trackId, outputDir, onProgress) {
  const errors = [];

  // 1. Try MusicDL API first (most likely to work)
  try {
    const info = await downloadFromMusicDL(trackId);
    return await processTrackInfo(info, trackId, outputDir, onProgress, 'musicdl');
  } catch (err) {
    console.error(`[Tidal] MusicDL failed: ${err.message}`);
    errors.push(`MusicDL: ${err.message}`);
  }

  // 2. Try rotating hifi-api endpoints
  const apis = await fetchTidalAPIList();

  for (const apiUrl of apis) {
    try {
      const info = await getTidalTrackInfo(trackId, apiUrl);
      return await processTrackInfo(info, trackId, outputDir, onProgress, apiUrl);
    } catch (err) {
      console.error(`[Tidal] API ${apiUrl} failed: ${err.message}`);
      errors.push(`${apiUrl}: ${err.message}`);
      continue;
    }
  }

  // All providers failed
  console.error('[Tidal] All providers failed:');
  errors.forEach(e => console.error(`  ✗ ${e}`));

  throw new Error(
    'All Tidal API endpoints failed. Tidal APIs are currently experiencing widespread outages. ' +
    'Try using a Qobuz link instead, or try again later.'
  );
}

module.exports = {
  parseTidalURL,
  fetchTidalAPIList,
  getTidalTrackInfo,
  downloadTidalTrack,
  parseManifest,
  downloadFromMusicDL,
};
