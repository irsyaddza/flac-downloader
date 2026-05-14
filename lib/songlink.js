const { createHttpClient } = require('./utils');
const crypto = require('crypto');

const SONGLINK_API = 'https://api.song.link/v1-alpha.1/links';
const MUSICDL_SEARCH_API = 'https://www.musicdl.me/api/qobuz/search';

// Debug key (shared with qobuz.js and tidal.js)
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

function getDebugKey() {
  if (_debugKey) return _debugKey;
  const hasher = crypto.createHash('sha256');
  for (const part of DEBUG_KEY_SEED_PARTS) hasher.update(part);
  const key = hasher.digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, DEBUG_KEY_NONCE);
  decipher.setAAD(DEBUG_KEY_AAD);
  decipher.setAuthTag(DEBUG_KEY_TAG);
  _debugKey = Buffer.concat([decipher.update(DEBUG_KEY_CIPHERTEXT), decipher.final()]).toString('utf-8');
  return _debugKey;
}

/**
 * Search Qobuz via MusicDL API to find a track by title and artist.
 * Returns the Qobuz track ID of the best match.
 * 
 * @param {string} title - Track title
 * @param {string} artist - Artist name
 * @returns {Object|null} { qobuzTrackId, title, artistName, albumName }
 */
async function searchQobuzTrack(title, artist) {
  const client = createHttpClient(15000);
  const debugKey = getDebugKey();
  const query = `${title} ${artist}`.trim();

  console.log(`[Songlink] Searching Qobuz for: "${query}"`);

  const response = await client.get(MUSICDL_SEARCH_API, {
    params: { q: query },
    headers: { 'X-Debug-Key': debugKey },
  });

  const data = response.data;
  if (!data.success) {
    throw new Error('Qobuz search failed');
  }

  // Search through albums to find tracks
  const albums = data.data?.albums?.items || [];
  
  // Try to find a matching track in the album results
  for (const album of albums) {
    // Check if album has tracks listed
    if (album.tracks?.items) {
      for (const track of album.tracks.items) {
        if (matchesTrack(track.title, title)) {
          console.log(`[Songlink] Found Qobuz track: "${track.title}" (ID: ${track.id}) in album "${album.title}"`);
          return {
            qobuzTrackId: String(track.id),
            title: track.title,
            artistName: album.artist?.name || artist,
            albumName: album.title,
            coverUrl: album.image?.large || album.image?.small || null,
            isrc: track.isrc || null,
          };
        }
      }
    }
  }

  // If no track-level match, search for tracks directly
  const tracks = data.data?.tracks?.items || [];
  for (const track of tracks) {
    if (matchesTrack(track.title, title)) {
      console.log(`[Songlink] Found Qobuz track: "${track.title}" (ID: ${track.id})`);
      return {
        qobuzTrackId: String(track.id),
        title: track.title,
        artistName: track.performer?.name || artist,
        albumName: track.album?.title || '',
        coverUrl: track.album?.image?.large || track.album?.image?.small || null,
        isrc: track.isrc || null,
      };
    }
  }

  // Fallback: if the search returned any tracks at all, use the first one
  if (tracks.length > 0) {
    const first = tracks[0];
    console.log(`[Songlink] Using first Qobuz result: "${first.title}" (ID: ${first.id})`);
    return {
      qobuzTrackId: String(first.id),
      title: first.title,
      artistName: first.performer?.name || artist,
      albumName: first.album?.title || '',
      coverUrl: first.album?.image?.large || first.album?.image?.small || null,
      isrc: first.isrc || null,
    };
  }

  console.warn('[Songlink] No Qobuz tracks found');
  return null;
}

/**
 * Search Qobuz for tracks and return an array of top results (for autocomplete)
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of tracks to return
 * @returns {Array} Array of track objects
 */
async function searchQobuzTracks(query, limit = 5) {
  const client = createHttpClient(15000);
  const debugKey = getDebugKey();

  console.log(`[Songlink] Searching Qobuz (multiple) for: "${query}"`);

  const response = await client.get(MUSICDL_SEARCH_API, {
    params: { q: query },
    headers: { 'X-Debug-Key': debugKey },
  });

  const data = response.data;
  if (!data.success) {
    throw new Error('Qobuz search failed');
  }

  const results = [];
  const tracks = data.data?.tracks?.items || [];
  
  for (const track of tracks) {
    if (results.length >= limit) break;
    
    // Check if we already have this track (by ID or exact title+artist combo)
    const isDuplicate = results.some(r => 
      r.qobuzTrackId === String(track.id) || 
      (r.title === track.title && r.artistName === track.performer?.name)
    );
    
    if (!isDuplicate) {
      results.push({
        qobuzTrackId: String(track.id),
        title: track.title,
        artistName: track.performer?.name || 'Unknown Artist',
        albumName: track.album?.title || '',
        coverUrl: track.album?.image?.small || track.album?.image?.large || null,
        isrc: track.isrc || null,
        duration: track.duration || 0
      });
    }
  }

  return results;
}

/**
 * Simple fuzzy title matching
 */
function matchesTrack(resultTitle, searchTitle) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(resultTitle) === normalize(searchTitle) || 
         normalize(resultTitle).includes(normalize(searchTitle)) ||
         normalize(searchTitle).includes(normalize(resultTitle));
}

/**
 * Use Songlink/Odesli to find equivalent links across platforms.
 * Falls back to MusicDL Qobuz search if Songlink fails.
 */
async function getLinksFromURL(url) {
  const client = createHttpClient(15000);
  
  console.log(`[Songlink] Looking up: ${url}`);
  
  const response = await client.get(SONGLINK_API, {
    params: { url, userCountry: 'US' },
  });

  const data = response.data;
  const result = {};

  if (data.linksByPlatform) {
    const platforms = data.linksByPlatform;
    if (platforms.qobuz) result.qobuzUrl = platforms.qobuz.url;
    if (platforms.tidal) result.tidalUrl = platforms.tidal.url;
    if (platforms.spotify) result.spotifyUrl = platforms.spotify.url;
  }

  if (data.entitiesByUniqueId) {
    const entities = Object.values(data.entitiesByUniqueId);
    if (entities.length > 0) {
      const entity = entities[0];
      result.title = entity.title;
      result.artistName = entity.artistName;
      result.thumbnailUrl = entity.thumbnailUrl;
    }
  }

  return result;
}

/**
 * Given a Tidal URL, find the equivalent Qobuz track.
 * Strategy:
 *   1. Try Songlink API (fast but may not have Qobuz)
 *   2. If Songlink has title/artist, search Qobuz via MusicDL
 *   3. Extract title/artist from Tidal track ID via musicdl info endpoint
 * 
 * @param {string} tidalUrl - Tidal track URL
 * @returns {Object|null} { qobuzTrackId, qobuzUrl, title, artistName }
 */
async function findQobuzFromTidal(tidalUrl) {
  let title = null;
  let artist = null;

  // Step 1: Try Songlink to get track metadata
  try {
    const links = await getLinksFromURL(tidalUrl);
    
    // If Songlink found a Qobuz URL directly
    if (links.qobuzUrl) {
      console.log(`[Songlink] Found Qobuz URL directly: ${links.qobuzUrl}`);
      return {
        qobuzUrl: links.qobuzUrl,
        title: links.title,
        artistName: links.artistName,
      };
    }
    
    // Use title/artist from Songlink for Qobuz search
    if (links.title && links.artistName) {
      title = links.title;
      artist = links.artistName;
    }
  } catch (err) {
    console.warn(`[Songlink] Songlink lookup failed: ${err.message}`);
  }

  // Step 2: Try getting track info from musicdl Tidal info endpoint
  if (!title) {
    try {
      const trackIdMatch = tidalUrl.match(/\/track\/(\d+)/);
      if (trackIdMatch) {
        const client = createHttpClient(10000);
        const debugKey = getDebugKey();
        const response = await client.get(`https://www.musicdl.me/api/tidal/track/${trackIdMatch[1]}`, {
          headers: { 'X-Debug-Key': debugKey },
        });
        
        if (response.data && typeof response.data === 'object') {
          const track = response.data.track || response.data;
          title = track.title;
          artist = track.artist?.name || track.artistName;
        }
      }
    } catch (err) {
      console.warn(`[Songlink] Tidal info lookup failed: ${err.message}`);
    }
  }

  // Step 3: Search Qobuz using title + artist
  if (title) {
    try {
      const qobuzResult = await searchQobuzTrack(title, artist || '');
      if (qobuzResult) {
        return {
          qobuzTrackId: qobuzResult.qobuzTrackId,
          qobuzUrl: `https://open.qobuz.com/track/${qobuzResult.qobuzTrackId}`,
          title: qobuzResult.title,
          artistName: qobuzResult.artistName,
        };
      }
    } catch (err) {
      console.error(`[Songlink] Qobuz search failed: ${err.message}`);
    }
  }

  console.warn('[Songlink] Could not find Qobuz equivalent');
  return null;
}

module.exports = {
  getLinksFromURL,
  findQobuzFromTidal,
  searchQobuzTrack,
  searchQobuzTracks,
  getDebugKey,
};
