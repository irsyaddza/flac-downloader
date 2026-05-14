// ═══════════════════════════════════════════════════════════
//  FLAC Downloader — Frontend Application Logic
// ═══════════════════════════════════════════════════════════

const API_BASE = '';
let currentDownloadId = null;
let pollInterval = null;
let detectedService = null;
let selectedQuality = { tidal: 'LOSSLESS', qobuz: '27' };

// ─── DOM Elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const urlInput = $('#urlInput');
const downloadBtn = $('#downloadBtn');
const pasteBtn = $('#pasteBtn');
const serviceBadgeWrapper = $('#serviceBadgeWrapper');
const serviceBadge = $('#serviceBadge');
const serviceIcon = $('#serviceIcon');
const serviceName = $('#serviceName');
const serviceTrackId = $('#serviceTrackId');
const qualitySelector = $('#qualitySelector');
const downloadSection = $('#downloadSection');
const downloadTitle = $('#downloadTitle');
const downloadSubtitle = $('#downloadSubtitle');
const downloadStatusBadge = $('#downloadStatusBadge');
const downloadStatusText = $('#downloadStatusText');
const progressFill = $('#progressFill');
const progressGlow = $('#progressGlow');
const progressPercent = $('#progressPercent');
const progressSize = $('#progressSize');
const downloadActions = $('#downloadActions');
const saveFileBtn = $('#saveFileBtn');
const newDownloadBtn = $('#newDownloadBtn');
const historySection = $('#historySection');
const historyList = $('#historyList');
const clearHistoryBtn = $('#clearHistoryBtn');
const headerStatus = $('#headerStatus');

// ─── URL Detection ──────────────────────────────────────────
function detectServiceFromURL(url) {
  if (/tidal\.com|listen\.tidal/i.test(url)) return 'tidal';
  if (/qobuz\.com/i.test(url)) return 'qobuz';
  // If it doesn't look like a URL but has text, treat as search
  if (url.length >= 2 && !url.includes('://') && !url.includes('.com') && !url.includes('.org')) {
    return 'search';
  }
  return null;
}

function extractTrackId(url, service) {
  const match = url.match(/\/track\/(\d+)/);
  return match ? match[1] : null;
}

const searchDropdown = document.getElementById('searchDropdown');
const searchResultsList = document.getElementById('searchResultsList');

let searchTimeout = null;

// Hide dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!searchDropdown.contains(e.target) && e.target !== urlInput) {
    searchDropdown.classList.add('hidden');
  }
});

// Show dropdown again on focus if we have text
urlInput.addEventListener('focus', () => {
  if (urlInput.value.trim().length >= 2 && detectServiceFromURL(urlInput.value.trim()) === 'search') {
    searchDropdown.classList.remove('hidden');
  }
});

urlInput.addEventListener('input', () => {
  const url = urlInput.value.trim();
  const service = detectServiceFromURL(url);
  const btnLabel = downloadBtn.querySelector('span');
  
  if (service) {
    detectedService = service;
    
    if (service === 'search') {
      serviceBadge.className = 'service-badge qobuz';
      serviceIcon.textContent = '🔍';
      serviceName.textContent = 'Search Qobuz';
      serviceTrackId.textContent = '';
      if (btnLabel) btnLabel.textContent = '🔍  Search & Download';
      
      // Handle Autocomplete Debouncing
      clearTimeout(searchTimeout);
      if (url.length >= 2) {
        searchDropdown.classList.remove('hidden');
        searchResultsList.innerHTML = '<li class="search-loading">Searching Qobuz...</li>';
        
        searchTimeout = setTimeout(async () => {
          try {
            const resp = await fetch(`${API_BASE}/api/search/suggestions?q=${encodeURIComponent(url)}`);
            const data = await resp.json();
            
            if (data.success && data.tracks && data.tracks.length > 0) {
              renderSearchSuggestions(data.tracks);
            } else {
              searchResultsList.innerHTML = '<li class="search-loading">No tracks found.</li>';
            }
          } catch (e) {
            searchResultsList.innerHTML = '<li class="search-loading" style="color: var(--error)">Search failed.</li>';
          }
        }, 400); // 400ms debounce
      } else {
        searchDropdown.classList.add('hidden');
      }
    } else {
      searchDropdown.classList.add('hidden');
      clearTimeout(searchTimeout);
      const trackId = extractTrackId(url, service);
      serviceBadge.className = `service-badge ${service}`;
      serviceIcon.textContent = service === 'tidal' ? '🌊' : '🎵';
      serviceName.textContent = service.charAt(0).toUpperCase() + service.slice(1);
      serviceTrackId.textContent = trackId ? `#${trackId}` : '';
      if (btnLabel) btnLabel.textContent = '⬇  Download FLAC';
    }
    
    serviceBadgeWrapper.style.display = 'block';
    qualitySelector.style.display = service !== 'search' ? 'block' : 'none';
    downloadBtn.disabled = false;
  } else {
    searchDropdown.classList.add('hidden');
    clearTimeout(searchTimeout);
    detectedService = null;
    serviceBadgeWrapper.style.display = 'none';
    qualitySelector.style.display = url.length > 0 ? 'none' : 'none';
    downloadBtn.disabled = true;
    if (btnLabel) btnLabel.textContent = '⬇  Download FLAC';
  }
});

// ─── Paste Button ───────────────────────────────────────────
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text;
    urlInput.dispatchEvent(new Event('input'));
    showToast('Pasted from clipboard', 'info');
  } catch {
    showToast('Cannot access clipboard', 'error');
  }
});

// ─── Quality Selection ──────────────────────────────────────
document.querySelectorAll('.quality-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedQuality.tidal = btn.dataset.quality;
    selectedQuality.qobuz = btn.dataset.qobuz;
  });
});

// ─── Download ───────────────────────────────────────────────
downloadBtn.addEventListener('click', startDownload);

async function startDownload() {
  const url = urlInput.value.trim();
  if (!url) return;

  downloadBtn.disabled = true;
  downloadBtn.classList.add('loading');

  try {
    let body;
    
    if (detectedService === 'search') {
      // Search mode: find track on Qobuz first
      setHeaderStatus('Searching...', 'downloading');
      showToast(`Searching Qobuz for "${url}"...`, 'info');
      
      const searchResp = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(url)}`);
      const searchData = await searchResp.json();
      
      if (!searchData.success || !searchData.track) {
        throw new Error(searchData.error || 'No tracks found on Qobuz. Try a different search.');
      }
      
      showToast(`Found: ${searchData.track.title} — ${searchData.track.artist}`, 'success');
      setHeaderStatus('Downloading...', 'downloading');
      
      body = {
        searchTrackId: searchData.track.id,
        searchQuery: url,
        trackTitle: searchData.track.title,
        trackArtist: searchData.track.artist,
        quality: '27',
      };
    } else {
      // URL mode
      setHeaderStatus('Downloading...', 'downloading');
      const quality = detectedService === 'qobuz' ? selectedQuality.qobuz : selectedQuality.tidal;
      body = { url, quality };
    }

    const resp = await fetch(`${API_BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (data.id) {
      currentDownloadId = data.id;
      showDownloadProgress(data);
      addToHistory(data);
      startPolling(data.id);
      urlInput.value = '';
      urlInput.dispatchEvent(new Event('input'));
    } else {
      throw new Error(data.error || 'Failed to start download');
    }
  } catch (err) {
    showToast(err.message, 'error');
    setHeaderStatus('Failed', 'failed');
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.classList.remove('loading');
  }
}

/**
 * Render search results into the autocomplete dropdown
 */
function renderSearchSuggestions(tracks) {
  searchResultsList.innerHTML = '';
  
  tracks.forEach(track => {
    const li = document.createElement('li');
    li.className = 'search-item';
    
    // Use a placeholder if cover art is missing
    const coverUrl = track.coverUrl || 'https://via.placeholder.com/60?text=No+Cover';
    
    li.innerHTML = `
      <img src="${coverUrl}" class="search-item-cover" loading="lazy">
      <div class="search-item-info">
        <span class="search-item-title">${track.title}</span>
        <span class="search-item-artist">${track.artistName}</span>
      </div>
      <span class="search-item-service">Qobuz</span>
    `;
    
    li.addEventListener('click', () => {
      // Fill the input and start download
      urlInput.value = `${track.artistName} - ${track.title}`;
      searchDropdown.classList.add('hidden');
      
      // Manually trigger the download with the selected ID to be precise
      initiateDirectDownload({
        id: track.qobuzTrackId,
        title: track.title,
        artist: track.artistName
      });
    });
    
    searchResultsList.appendChild(li);
  });
}

/**
 * Directly start a download from a selected search result
 */
async function initiateDirectDownload(track) {
  downloadBtn.disabled = true;
  downloadBtn.classList.add('loading');
  setHeaderStatus('Downloading...', 'downloading');
  showToast(`Starting download: ${track.title}`, 'info');

  try {
    const body = {
      searchTrackId: track.id,
      trackTitle: track.title,
      trackArtist: track.artist,
      quality: '27',
    };

    const resp = await fetch(`${API_BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (data.id) {
      currentDownloadId = data.id;
      showDownloadProgress(data);
      addToHistory(data);
      startPolling(data.id);
      urlInput.value = '';
      urlInput.dispatchEvent(new Event('input'));
    } else {
      throw new Error(data.error || 'Failed to start download');
    }
  } catch (err) {
    showToast(err.message, 'error');
    setHeaderStatus('Failed', 'failed');
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.classList.remove('loading');
  }
}

// ─── Download Progress UI ───────────────────────────────────
function showDownloadProgress(data) {
  downloadSection.style.display = 'block';
  downloadTitle.textContent = `Downloading ${data.service.charAt(0).toUpperCase() + data.service.slice(1)} Track`;
  downloadSubtitle.textContent = `Track ID: ${data.trackId}`;
  downloadStatusBadge.className = 'download-status-badge';
  downloadStatusText.textContent = 'In Progress';
  downloadActions.style.display = 'none';
  updateProgress(0);
  
  downloadSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateProgress(percent, sizeText) {
  progressFill.style.width = `${percent}%`;
  progressGlow.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  if (sizeText) progressSize.textContent = sizeText;
}

// ─── Polling ────────────────────────────────────────────────
function startPolling(downloadId) {
  if (pollInterval) clearInterval(pollInterval);
  
  pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/status/${downloadId}`);
      const data = await response.json();

      if (data.status === 'downloading' || data.status === 'converting' || data.status === 'fallback') {
        updateProgress(data.progress || 0, data.sizeFormatted || '');
        if (data.status === 'fallback') {
          downloadStatusText.textContent = 'Tidal unavailable — trying Qobuz...';
          downloadTitle.textContent = 'Auto-switching to Qobuz';
        } else if (data.status === 'converting') {
          downloadStatusText.textContent = 'Converting to FLAC...';
        } else {
          downloadStatusText.textContent = 'Downloading...';
        }
      }

      if (data.status === 'completed') {
        clearInterval(pollInterval);
        pollInterval = null;
        onDownloadComplete(data);
      }

      if (data.status === 'failed') {
        clearInterval(pollInterval);
        pollInterval = null;
        onDownloadFailed(data);
      }

      updateHistoryItem(downloadId, data);

    } catch (err) {
      console.error('Poll error:', err);
    }
  }, 1000);
}

function onDownloadComplete(data) {
  updateProgress(100, data.sizeFormatted);
  downloadStatusBadge.classList.add('completed');
  downloadStatusText.textContent = '✓ Completed';
  downloadTitle.textContent = data.fileName || 'Download Complete';
  
  let subtitle = `${data.quality || 'FLAC'} · ${data.sizeFormatted || ''}`;
  if (data.fallback) {
    subtitle += ' · 🔄 via Qobuz fallback';
  }
  downloadSubtitle.textContent = subtitle;
  
  downloadActions.style.display = 'flex';
  setHeaderStatus('Ready', 'ready');
  
  const toastMsg = data.fallback 
    ? `Downloaded via Qobuz (Tidal was unavailable): ${data.fileName}`
    : `Download complete: ${data.fileName}`;
  showToast(toastMsg, 'success');
}

function onDownloadFailed(data) {
  downloadStatusBadge.classList.add('failed');
  downloadStatusText.textContent = '✗ Failed';
  downloadTitle.textContent = 'Download Failed';
  downloadSubtitle.textContent = data.error || 'Unknown error';
  downloadActions.style.display = 'flex';
  saveFileBtn.style.display = 'none';
  setHeaderStatus('Error', 'error');
  showToast(`Download failed: ${data.error}`, 'error');
}

// ─── File Save ──────────────────────────────────────────────
saveFileBtn.addEventListener('click', () => {
  if (!currentDownloadId) return;
  window.open(`${API_BASE}/api/file/${currentDownloadId}`, '_blank');
});

newDownloadBtn.addEventListener('click', () => {
  downloadSection.style.display = 'none';
  urlInput.value = '';
  urlInput.dispatchEvent(new Event('input'));
  urlInput.focus();
  saveFileBtn.style.display = '';
  currentDownloadId = null;
  setHeaderStatus('Ready', 'ready');
});

// ─── History ────────────────────────────────────────────────
function addToHistory(data) {
  historySection.style.display = 'block';
  
  const existing = historyList.querySelector(`[data-id="${data.downloadId}"]`);
  if (existing) return;

  const item = document.createElement('div');
  item.className = 'history-item';
  item.dataset.id = data.downloadId;
  item.innerHTML = `
    <div class="history-item-info">
      <div class="history-item-name">${data.service} — Track #${data.trackId}</div>
      <div class="history-item-meta">${new Date().toLocaleTimeString()}</div>
    </div>
    <span class="history-item-badge downloading">Downloading</span>
    <div class="history-item-actions">
      <button class="history-dl-btn" data-id="${data.downloadId}" style="display:none">Save</button>
    </div>
  `;

  historyList.prepend(item);
  
  // Bind save button
  item.querySelector('.history-dl-btn').addEventListener('click', () => {
    window.open(`${API_BASE}/api/file/${data.downloadId}`, '_blank');
  });
}

function updateHistoryItem(downloadId, data) {
  const item = historyList.querySelector(`[data-id="${downloadId}"]`);
  if (!item) return;

  const badge = item.querySelector('.history-item-badge');
  const dlBtn = item.querySelector('.history-dl-btn');
  const name = item.querySelector('.history-item-name');
  const meta = item.querySelector('.history-item-meta');

  if (data.status === 'completed') {
    badge.className = 'history-item-badge completed';
    badge.textContent = data.sizeFormatted || 'Done';
    dlBtn.style.display = '';
    if (data.fileName) name.textContent = data.fileName;
    meta.textContent = `${data.quality || 'FLAC'} · ${new Date().toLocaleTimeString()}`;
  } else if (data.status === 'failed') {
    badge.className = 'history-item-badge failed';
    badge.textContent = 'Failed';
  } else {
    badge.textContent = `${data.progress || 0}%`;
  }
}

clearHistoryBtn.addEventListener('click', () => {
  historyList.innerHTML = '';
  historySection.style.display = 'none';
});

// ─── Header Status ──────────────────────────────────────────
function setHeaderStatus(text, state) {
  const statusText = headerStatus.querySelector('.status-text');
  const statusDot = headerStatus.querySelector('.status-dot');
  statusText.textContent = text;
  
  headerStatus.style.background = 
    state === 'downloading' ? 'rgba(99,102,241,0.08)' :
    state === 'error' ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)';
  headerStatus.style.borderColor = 
    state === 'downloading' ? 'rgba(99,102,241,0.15)' :
    state === 'error' ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';
  
  const color = state === 'downloading' ? '#6366f1' : state === 'error' ? '#ef4444' : '#22c55e';
  statusText.style.color = color;
  statusDot.style.background = color;
}

// ─── Toast Notifications ────────────────────────────────────
function showToast(message, type = 'info') {
  const container = $('#toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ─── Init ───────────────────────────────────────────────────
(async function init() {
  try {
    const resp = await fetch(`${API_BASE}/api/health`);
    const data = await resp.json();
    if (data.ffmpeg === 'not found') {
      showToast('FFmpeg not found — metadata embedding disabled', 'info');
    }
  } catch {
    showToast('Server connection failed', 'error');
    setHeaderStatus('Offline', 'error');
  }
})();
