const { createHttpClient, downloadFile } = require('./utils');
const crypto = require('crypto');
const path = require('path');

// Qobuz API endpoints (same as SpotiFLAC)
const QOBUZ_STREAM_API_URLS = [
  'https://dab.yeet.su/api/stream?trackId=',
  'https://dabmusic.xyz/api/stream?trackId=',
];

const QOBUZ_MUSICDL_API_URL = 'https://www.musicdl.me/api/qobuz/download';

// Debug key seed parts (from SpotiFLAC source)
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
 * Decrypt the MusicDL debug key (matches SpotiFLAC's getQobuzMusicDLDebugKey)
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

/**
 * Parse a Qobuz URL to extract the track ID
 * Supports: https://open.qobuz.com/track/123456, https://www.qobuz.com/xx-xx/album/.../track-id
 */
function parseQobuzURL(url) {
  // Format: /track/123456
  let match = url.match(/\/track\/(\d+)/);
  if (match) {
    return match[1];
  }

  // Format: /album/...  (album page — not supported for single track)
  match = url.match(/qobuz\.com/);
  if (match) {
    // Try to extract numeric ID from end of URL
    const numMatch = url.match(/(\d{5,})(?:\?|$|\/)/);
    if (numMatch) return numMatch[1];
  }

  throw new Error('Invalid Qobuz URL. Expected format: https://open.qobuz.com/track/{id}');
}

/**
 * Try downloading from dabmusic.xyz / yeet.su standard API
 */
async function downloadFromStandard(apiBase, trackId, quality) {
  const client = createHttpClient(30000);
  const url = `${apiBase}${trackId}&quality=${quality}`;
  console.log(`[Qobuz] Trying standard API: ${url}`);

  const response = await client.get(url);
  const body = response.data;

  // Direct URL response
  if (body && body.url) return body.url;
  if (body && body.data && body.data.url) return body.data.url;

  throw new Error('No download URL in standard API response');
}

/**
 * Try downloading from musicdl.me API (needs debug key)
 */
async function downloadFromMusicDL(trackId, quality) {
  const client = createHttpClient(60000);
  const debugKey = getDebugKey();

  const payload = {
    url: `https://open.qobuz.com/track/${trackId}`,
    quality: quality || '6',
  };

  console.log(`[Qobuz] Trying MusicDL API...`);

  const response = await client.post(QOBUZ_MUSICDL_API_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Key': debugKey,
    },
  });

  const body = response.data;

  if (!body.success) {
    throw new Error(body.error || body.message || 'MusicDL reported failure');
  }

  if (!body.download_url) {
    throw new Error('MusicDL did not return a download URL');
  }

  return body.download_url;
}

/**
 * Get download URL for a Qobuz track, trying multiple providers with quality fallback
 * Quality codes: 5=MP3, 6=CD (16-bit/44.1kHz), 7=24-bit, 27=Hi-Res
 */
async function getQobuzDownloadURL(trackId, quality = '27') {
  const providers = [
    { name: 'MusicDL', fn: () => downloadFromMusicDL(trackId, quality) },
    ...QOBUZ_STREAM_API_URLS.map(api => ({
      name: `Standard(${api})`,
      fn: () => downloadFromStandard(api, trackId, quality),
    })),
  ];

  let lastErr;

  // Try with requested quality
  for (const provider of providers) {
    try {
      console.log(`[Qobuz] Trying ${provider.name} (quality: ${quality})...`);
      const url = await provider.fn();
      console.log(`[Qobuz] ✓ Success with ${provider.name}`);
      return url;
    } catch (err) {
      console.error(`[Qobuz] ${provider.name} failed: ${err.message}`);
      lastErr = err;
    }
  }

  // Fallback quality chain: 27 → 7 → 6
  const fallbacks = quality === '27' ? ['7', '6'] : quality === '7' ? ['6'] : [];

  for (const fallbackQ of fallbacks) {
    console.log(`[Qobuz] Trying fallback quality: ${fallbackQ}`);
    for (const provider of providers) {
      try {
        const fallbackFn = provider.name === 'MusicDL'
          ? () => downloadFromMusicDL(trackId, fallbackQ)
          : () => downloadFromStandard(QOBUZ_STREAM_API_URLS.find(u => provider.name.includes(u)) || QOBUZ_STREAM_API_URLS[0], trackId, fallbackQ);

        const url = await fallbackFn();
        console.log(`[Qobuz] ✓ Success with fallback quality ${fallbackQ}`);
        return url;
      } catch (err) {
        lastErr = err;
      }
    }
  }

  throw lastErr || new Error('All Qobuz providers and quality fallbacks failed');
}

/**
 * Download a Qobuz track to disk
 */
async function downloadQobuzTrack(trackId, outputDir, quality, onProgress) {
  const downloadUrl = await getQobuzDownloadURL(trackId, quality);
  const filename = `qobuz_${trackId}.flac`;
  const outputPath = path.join(outputDir, filename);

  console.log(`[Qobuz] Downloading FLAC to: ${outputPath}`);
  const result = await downloadFile(downloadUrl, outputPath, onProgress);

  return {
    filePath: result.path,
    quality: quality === '27' ? 'Hi-Res (24-bit)' : quality === '7' ? '24-bit Standard' : 'CD Quality (16-bit/44.1kHz)',
    size: result.size,
    sizeFormatted: result.sizeFormatted,
  };
}

module.exports = {
  parseQobuzURL,
  getQobuzDownloadURL,
  downloadQobuzTrack,
  downloadFromStandard,
  downloadFromMusicDL,
};
