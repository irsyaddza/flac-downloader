const { createHttpClient } = require('./utils');
const axios = require('axios');
const https = require('https');

const LRCLIB_BASE = 'https://lrclib.net';

/**
 * Create an HTTP client specifically for LRCLIB.
 * LRCLIB's SSL certificate may expire periodically — this client
 * tolerates that to keep lyrics fetching working.
 */
function createLrcLibClient(timeout = 15000) {
  return axios.create({
    timeout,
    headers: {
      'User-Agent': 'FLACDownloader/1.0 (https://github.com/irsyaddza/flac-downloader)',
      'Accept': 'application/json',
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });
}

/**
 * Fetch lyrics from LRCLIB API using exact track signature.
 * This is the most accurate method — requires title, artist, album, and duration.
 *
 * @param {string} title - Track title
 * @param {string} artist - Artist name
 * @param {string} album - Album name (optional but recommended)
 * @param {number} duration - Track duration in seconds (optional but recommended)
 * @returns {Object|null} { syncedLyrics, plainLyrics } or null
 */
async function fetchLyricsBySignature(title, artist, album, duration) {
  if (!title || !artist) return null;

  const client = createLrcLibClient();
  const params = {
    track_name: title,
    artist_name: artist,
  };

  if (album) params.album_name = album;
  if (duration && duration > 0) params.duration = Math.round(duration);

  try {
    console.log(`[Lyrics] Trying exact match: "${title}" by "${artist}"`);
    const response = await client.get(`${LRCLIB_BASE}/api/get`, {
      params,
    });

    const data = response.data;

    if (data && (data.syncedLyrics || data.plainLyrics)) {
      console.log(`[Lyrics] ✓ Found via exact match (synced: ${!!data.syncedLyrics}, plain: ${!!data.plainLyrics})`);
      return {
        syncedLyrics: data.syncedLyrics || null,
        plainLyrics: data.plainLyrics || null,
      };
    }

    console.log('[Lyrics] Exact match returned no lyrics');
    return null;
  } catch (err) {
    // 404 means no lyrics found — not an error
    if (err.response && err.response.status === 404) {
      console.log('[Lyrics] No exact match found (404)');
      return null;
    }
    console.error(`[Lyrics] Exact match error: ${err.message}`);
    return null;
  }
}

/**
 * Search LRCLIB for lyrics using a text query.
 * Fallback method when exact signature lookup fails.
 *
 * @param {string} title - Track title
 * @param {string} artist - Artist name
 * @returns {Object|null} { syncedLyrics, plainLyrics } or null
 */
async function searchLyrics(title, artist) {
  if (!title) return null;

  const client = createLrcLibClient();
  const query = artist ? `${title} ${artist}` : title;

  try {
    console.log(`[Lyrics] Searching: "${query}"`);
    const response = await client.get(`${LRCLIB_BASE}/api/search`, {
      params: { q: query },
    });

    const results = response.data;

    if (!Array.isArray(results) || results.length === 0) {
      console.log('[Lyrics] Search returned no results');
      return null;
    }

    // Find the best match — prioritize results with synced lyrics
    const withSynced = results.find(r => r.syncedLyrics);
    const best = withSynced || results.find(r => r.plainLyrics) || results[0];

    if (best && (best.syncedLyrics || best.plainLyrics)) {
      console.log(`[Lyrics] ✓ Found via search: "${best.trackName}" by "${best.artistName}" (synced: ${!!best.syncedLyrics}, plain: ${!!best.plainLyrics})`);
      return {
        syncedLyrics: best.syncedLyrics || null,
        plainLyrics: best.plainLyrics || null,
      };
    }

    console.log('[Lyrics] Search results had no lyrics content');
    return null;
  } catch (err) {
    console.error(`[Lyrics] Search error: ${err.message}`);
    return null;
  }
}

/**
 * Main function: Fetch lyrics using all available strategies.
 * Strategy order:
 *   1. Exact match by signature (title + artist + album + duration)
 *   2. Fallback search (title + artist)
 *
 * @param {string} title - Track title
 * @param {string} artist - Artist name
 * @param {string} album - Album name (optional)
 * @param {number} duration - Duration in seconds (optional)
 * @returns {Object|null} { syncedLyrics, plainLyrics } or null
 */
async function fetchLyrics(title, artist, album, duration) {
  if (!title) {
    console.log('[Lyrics] No title provided — skipping lyrics fetch');
    return null;
  }

  // Strategy 1: Exact match
  let result = await fetchLyricsBySignature(title, artist, album, duration);
  if (result) return result;

  // Strategy 2: Search fallback
  result = await searchLyrics(title, artist);
  if (result) return result;

  // Strategy 3: Try with simplified title (remove parenthetical content like "feat." or "(Remix)")
  const simplifiedTitle = title.replace(/\s*[\(\[].*?[\)\]]\s*/g, '').trim();
  if (simplifiedTitle !== title && simplifiedTitle.length > 0) {
    console.log(`[Lyrics] Retrying with simplified title: "${simplifiedTitle}"`);
    result = await searchLyrics(simplifiedTitle, artist);
    if (result) return result;
  }

  console.log('[Lyrics] No lyrics found from any source');
  return null;
}

module.exports = {
  fetchLyrics,
  fetchLyricsBySignature,
  searchLyrics,
};
