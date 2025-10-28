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

// Проверка наличия yt-dlp при старте
async function checkYtDlp() {
  try {
    const { stdout } = await execPromise('yt-dlp --version');
    console.log(`✅ yt-dlp version: ${stdout.trim()}`);
    return true;
  } catch (error) {
    console.error('❌ yt-dlp not found. Installing...');
    try {
      await execPromise('pip3 install yt-dlp || pip install yt-dlp');
      console.log('✅ yt-dlp installed successfully!');
      return true;
    } catch (installError) {
      console.error('❌ Failed to install yt-dlp:', installError.message);
      return false;
    }
  }
}

// Главная страница
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AETHEL Audio Backend',
    version: '2.2.0',
    downloader: 'yt-dlp (Python)',
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

    // Используем yt-dlp для получения метаданных
    const command = `yt-dlp --dump-json --no-warnings "${videoUrl}"`;
    const { stdout } = await execPromise(command);
    const metadata = JSON.parse(stdout);

    if (!metadata) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Находим лучший аудиоформат
    const audioFormats = metadata.formats.filter(f => 
      f.acodec !== 'none' && f.vcodec === 'none'
    );
    
    const bestAudio = audioFormats.reduce((best, format) => {
      const bestSize = best.filesize || best.filesize_approx || 0;
      const currentSize = format.filesize || format.filesize_approx || 0;
      return currentSize > bestSize ? format : best;
    }, audioFormats[0] || {});

    // Находим видео формат для сравнения
    const videoFormats = metadata.formats.filter(f => 
      f.vcodec !== 'none' && f.acodec !== 'none'
    );
    
    const bestVideo = videoFormats.length > 0 ? videoFormats[0] : null;

    const audioSize = bestAudio.filesize || bestAudio.filesize_approx || 0;
    const videoSize = bestVideo?.filesize || bestVideo?.filesize_approx || audioSize * 3;
    
    // Оценка размера после конвертации в AAC (~75% от оригинала)
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

// Скачивание и конвертация аудио
app.get('/api/download-audio/:videoId', async (req, res) => {
  let tempFile = null;
  
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    console.log(`📥 Downloading audio for: ${videoId}`);

    // Создаем временный файл
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    tempFile = path.join(tempDir, `${videoId}_${Date.now()}`);
    
    // Скачиваем аудио через yt-dlp
    const downloadCommand = `yt-dlp -f bestaudio -o "${tempFile}.%(ext)s" --no-playlist --no-warnings "${videoUrl}"`;
    await execPromise(downloadCommand);

    // Находим скачанный файл (расширение может быть .webm, .m4a, .opus и т.д.)
    const files = fs.readdirSync(tempDir).filter(f => f.startsWith(path.basename(tempFile)));
    
    if (files.length === 0) {
      throw new Error('Download failed - temp file not created');
    }
    
    const downloadedFile = path.join(tempDir, files[0]);
    console.log(`✅ Downloaded to: ${downloadedFile}`);

    // Настройки заголовков
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.m4a"`);

    // Конвертируем в AAC через FFmpeg и стримим клиенту
    const ffmpegStream = ffmpeg(downloadedFile)
      .audioBitrate(128)
      .audioCodec('aac')
      .audioChannels(2)
      .format('mp4')
      .on('start', (commandLine) => {
        console.log(`🎵 FFmpeg started`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`⏳ Converting: ${Math.floor(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log(`✅ Conversion completed: ${videoId}`);
        // Удаляем временный файл
        try {
          if (downloadedFile && fs.existsSync(downloadedFile)) {
            fs.unlinkSync(downloadedFile);
            console.log(`🗑️ Temp file deleted`);
          }
        } catch (e) {
          console.error('Error deleting temp file:', e.message);
        }
      })
      .on('error', (err) => {
        console.error(`❌ FFmpeg error: ${err.message}`);
        // Удаляем временный файл при ошибке
        try {
          if (downloadedFile && fs.existsSync(downloadedFile)) {
            fs.unlinkSync(downloadedFile);
          }
        } catch (e) {}
        
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Conversion failed', 
            message: err.message 
          });
        }
      });

    ffmpegStream.pipe(res, { end: true });

  } catch (error) {
    console.error('❌ Download error:', error.message);
    
    // Удаляем временные файлы при ошибке
    try {
      const tempDir = path.join(__dirname, 'temp');
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        files.forEach(file => {
          if (file.includes(req.params.videoId)) {
            fs.unlinkSync(path.join(tempDir, file));
          }
        });
      }
    } catch (e) {}
    
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to download audio',
        message: error.message
      });
    }
  }
});

// Запуск сервера после проверки yt-dlp
checkYtDlp().then((success) => {
  if (!success) {
    console.error('❌ Cannot start server without yt-dlp');
    process.exit(1);
  }
  
  app.listen(PORT, () => {
    console.log(`🚀 AETHEL Backend running on port ${PORT}`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🎵 Ready to process audio downloads!`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
