const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Кэш для хранения результатов
const cache = new Map();
const CACHE_TTL = 3600000; // 1 час

// Список User-Agents для ротации
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Очистка старого кэша каждые 10 минут
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
  console.log(`Cache cleanup: ${cache.size} items remaining`);
}, 600000);

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'AETHEL Audio Backend',
    version: '1.1.0',
    message: 'Server is running successfully!',
    cache_size: cache.size
  });
});

app.get('/api/audio-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    console.log(`[${new Date().toISOString()}] Getting info for: ${videoId}`);
    
    // Проверяем кэш
    const cached = cache.get(videoId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log(`[${new Date().toISOString()}] Cache HIT for: ${videoId}`);
      return res.json(cached.data);
    }
    
    console.log(`[${new Date().toISOString()}] Cache MISS for: ${videoId}`);
    
    // Опции для обхода 429
    const options = {
      requestOptions: {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
        }
      }
    };
    
    const info = await ytdl.getInfo(videoId, options);
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    
    if (audioFormats.length === 0) {
      console.log(`[${new Date().toISOString()}] No audio formats found for: ${videoId}`);
      return res.status(404).json({ error: 'No audio formats found' });
    }
    
    const bestAudio = audioFormats.reduce((best, format) => {
      const bestBitrate = best.audioBitrate || 0;
      const currentBitrate = format.audioBitrate || 0;
      return currentBitrate > bestBitrate ? format : best;
    });
    
    console.log(`[${new Date().toISOString()}] Success! Bitrate: ${bestAudio.audioBitrate}, Size: ${bestAudio.contentLength}`);
    
    const responseData = {
      videoId: videoId,
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds),
      url: bestAudio.url,
      size: parseInt(bestAudio.contentLength) || 0,
      bitrate: bestAudio.audioBitrate || 128,
      format: bestAudio.container || 'audio',
      quality: bestAudio.audioQuality || 'medium'
    };
    
    // Сохраняем в кэш
    cache.set(videoId, {
      data: responseData,
      timestamp: Date.now()
    });
    
    res.json(responseData);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error:`, error.message);
    
    // Если 429, возвращаем специальный код
    if (error.message.includes('429') || error.statusCode === 429) {
      return res.status(429).json({ 
        error: 'Rate limited',
        message: 'Too many requests. Please try again in a few minutes.',
        retry_after: 300 // 5 минут
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to get audio info',
      message: error.message 
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    cache_size: cache.size
  });
});

// Очистка кэша (для отладки)
app.post('/api/clear-cache', (req, res) => {
  cache.clear();
  res.json({ message: 'Cache cleared', size: 0 });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AETHEL Backend running on port ${PORT}`);
  console.log(`📍 Server started at ${new Date().toISOString()}`);
  console.log(`💾 Cache enabled with TTL: ${CACHE_TTL}ms`);
});
