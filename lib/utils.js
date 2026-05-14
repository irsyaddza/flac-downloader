const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Default browser-like headers
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Create an axios instance with default browser headers
 */
function createHttpClient(timeout = 30000) {
  return axios.create({
    timeout,
    headers: DEFAULT_HEADERS,
  });
}

/**
 * Sanitize a filename by removing invalid characters
 */
function sanitizeFilename(name) {
  if (!name) return 'unknown';
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

/**
 * Ensure a directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Format file size in human-readable form
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

/**
 * Download a file from URL to disk with progress tracking
 */
async function downloadFile(url, outputPath, onProgress) {
  const client = createHttpClient(300000); // 5 min timeout for large files
  
  const response = await client.get(url, {
    responseType: 'stream',
  });

  const totalLength = parseInt(response.headers['content-length'], 10) || 0;
  let downloaded = 0;

  ensureDir(path.dirname(outputPath));

  const writer = fs.createWriteStream(outputPath);

  return new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (onProgress && totalLength > 0) {
        onProgress({
          downloaded,
          total: totalLength,
          percent: Math.round((downloaded / totalLength) * 100),
        });
      }
    });

    response.data.pipe(writer);

    writer.on('finish', () => {
      resolve({
        path: outputPath,
        size: downloaded,
        sizeFormatted: formatSize(downloaded),
      });
    });

    writer.on('error', (err) => {
      fs.unlink(outputPath, () => {}); // cleanup
      reject(err);
    });

    response.data.on('error', (err) => {
      fs.unlink(outputPath, () => {}); // cleanup
      reject(err);
    });
  });
}

/**
 * Extract the first artist from a multi-artist string
 */
function getFirstArtist(artistString) {
  if (!artistString) return '';
  const delimiters = [', ', ' & ', ' feat. ', ' ft. ', ' featuring '];
  for (const d of delimiters) {
    const idx = artistString.toLowerCase().indexOf(d.toLowerCase());
    if (idx !== -1) {
      return artistString.substring(0, idx).trim();
    }
  }
  return artistString;
}

module.exports = {
  DEFAULT_HEADERS,
  createHttpClient,
  sanitizeFilename,
  ensureDir,
  formatSize,
  downloadFile,
  getFirstArtist,
};
