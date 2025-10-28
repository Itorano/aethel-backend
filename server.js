const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

const execPromise = promisify(exec);

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Путь к yt-dlp binary
const YT_DLP_PATH = path.join(__dirname, 'yt-dlp');

// Проверка наличия yt-dlp при старте
async function checkYtDlp() {
  try {
    if (!fs.existsSync(YT_DLP_PATH)) {
      console.log('📥 Downloading yt-dlp binary...');
      await execPromise(`wget -O ${YT_DLP_PATH} https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`);
      await execPromise(`chmod 755 ${YT_DLP_PATH}`);
      console.log('✅ yt-dlp downloaded and made executable!');
    }
    
    const { stdout } = await execPromise(`${YT_DLP_PATH} --version`);
    console.log(`✅ yt-dlp version: ${stdout.trim()}`);
    
    // Проверяем наличие cookies
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
      console.log('✅ cookies.txt found - YouTube authentication enabled');
    } else {
      console.log('⚠️  cookies.txt not found - some videos may fail due to bot detection');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Failed to setup yt-dlp:', error.message);
    return false;
  }
}

// Главная страница
app.get('/', (req, res) => {
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);
  
  res.json({
    status: 'ok',
    service: 'AETHEL Audio Backend',
    version: '2.6.0',
    downloader: 'yt-dlp (standalone)',
    authentication: hasCookies ? 'cookies enabled' : 'no cookies',
    endpoints: [
      'GET /api/audio-info/:videoId',
      'GET /api/download-audio/:videoId'
    ]
  });
});

// Получение информации о видео
app.get('/api/audio-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    console.log(`📊 Getting info for: ${videoId}`);

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies ${cookiesPath}` : '';
    
    const command = `${YT_DLP_PATH} ${cookiesArg} --dump-json --no-warnings --no-playlist "${videoUrl}"`;
    const { stdout } = await execPromise(command, { maxBuffer: 10 * 1024 * 1024 });
    const metadata = JSON.parse(stdout);

    if (!metadata) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const audioFormats = metadata.formats.filter(f => 
      f.acodec !== 'none' && f.vcodec === 'none'
    );
    
    const bestAudio = audioFormats.reduce((best, format) => {
      const bestSize = best.filesize || best.filesize_approx || 0;
      const currentSize = format.filesize || format.filesize_approx || 0;
      return currentSize > bestSize ? format : best;
    }, audioFormats[0] || {});

    const videoFormats = metadata.formats.filter(f => f.vcodec !== 'none');
    
    const bestVideo = videoFormats.length > 0 
      ? videoFormats.reduce((best, format) => {
          const bestSize = best.filesize || best.filesize_approx || 0;
          const currentSize = format.filesize || format.filesize_approx || 0;
          return currentSize > bestSize ? format : best;
        }, videoFormats[0])
      : null;

    const audioSize = bestAudio.filesize || bestAudio.filesize_approx || 0;
    const videoSize = bestVideo?.filesize || bestVideo?.filesize_approx || audioSize * 3;
    const estimatedAudioSize = Math.floor(audioSize * 0.75);

    res.json({
      videoId: videoId,
      title: metadata.title,
      duration: metadata.duration || 0,
      videoSize: videoSize,
      audioSize: estimatedAudioSize > 0 ? estimatedAudioSize : audioSize,
      bitrate: bestAudio.abr || 128,
      format: 'm4a',
      quality: bestAudio.quality || 'medium'
    });

    console.log(`✅ Info retrieved: ${metadata.title}`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      error: 'Failed to get audio info',
      message: error.message
    });
  }
});

// ОПТИМИЗИРОВАННЫЙ: Скачивание напрямую в M4A без FFmpeg
app.get('/api/download-audio/:videoId', async (req, res) => {
  let tempFile = null;
  
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    console.log(`📥 Downloading audio for: ${videoId}`);

    // Создаем временную директорию
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    tempFile = path.join(tempDir, `${videoId}_${Date.now()}.m4a`);
    
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies ${cookiesPath}` : '';

    // КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: Скачиваем сразу в M4A без конвертации через FFmpeg
    // Используем -x --audio-format m4a для конвертации внутри yt-dlp (быстрее)
    const downloadCommand = `${YT_DLP_PATH} ${cookiesArg} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a --audio-quality 128K -o "${tempFile}" --no-playlist --no-warnings "${videoUrl}"`;
    
    console.log(`🎵 Executing download (direct M4A)...`);
    
    // Увеличиваем таймаут и буфер для длинных видео
    await execPromise(downloadCommand, { 
      maxBuffer: 200 * 1024 * 1024, // 200MB буфер
      timeout: 600000 // 10 минут таймаут
    });

    // Проверяем файл
    if (!fs.existsSync(tempFile)) {
      throw new Error('Download failed - temp file not created');
    }

    const stats = fs.statSync(tempFile);
    console.log(`✅ Downloaded: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);

    if (stats.size === 0) {
      fs.unlinkSync(tempFile);
      throw new Error('Downloaded file is empty');
    }

    // Отправляем файл клиенту
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.m4a"`);
    res.setHeader('Content-Length', stats.size);

    const fileStream = fs.createReadStream(tempFile);
    
    fileStream.pipe(res);

    fileStream.on('end', () => {
      console.log(`✅ Transfer completed: ${videoId}`);
      // Удаляем временный файл после отправки
      try {
        fs.unlinkSync(tempFile);
        console.log(`🗑️ Temp file deleted`);
      } catch (e) {
        console.error('Error deleting temp file:', e.message);
      }
    });

    fileStream.on('error', (err) => {
      console.error(`❌ Stream error: ${err.message}`);
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch (e) {}
    });

  } catch (error) {
    console.error('❌ Download error:', error.message);
    console.error('Full error:', error);
    
    // Удаляем временные файлы при ошибке
    try {
      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {}
    
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to download audio',
        message: error.message,
        details: error.toString()
      });
    }
  }
});

// Очистка старых временных файлов при старте
function cleanupTempFiles() {
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
      try {
        fs.unlinkSync(path.join(tempDir, file));
      } catch (e) {}
    });
    console.log(`🗑️ Cleaned up ${files.length} temp files`);
  }
}

// Запуск сервера после проверки yt-dlp
checkYtDlp().then((success) => {
  if (!success) {
    console.error('❌ Cannot start server without yt-dlp');
    process.exit(1);
  }
  
  cleanupTempFiles();
  
  app.listen(PORT, () => {
    console.log(`🚀 AETHEL Backend running on port ${PORT}`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🎵 Ready to process audio downloads!`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
