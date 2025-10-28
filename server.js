const express = require('express');
const cors = require('cors');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Главная страница
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AETHEL Audio Backend',
    version: '2.1.0',
    downloader: 'yt-dlp',
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
    const metadata = await ytdlp(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
    });

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
    tempFile = path.join(__dirname, `temp_${videoId}_${Date.now()}.webm`);
    
    // Скачиваем аудио через yt-dlp
    await ytdlp(videoUrl, {
      output: tempFile,
      format: 'bestaudio',
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
    });

    console.log(`✅ Downloaded to temp file: ${tempFile}`);

    // Проверяем, что файл создан
    if (!fs.existsSync(tempFile)) {
      throw new Error('Download failed - temp file not created');
    }

    // Настройки заголовков
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.m4a"`);

    // Конвертируем в AAC через FFmpeg и стримим клиенту
    const ffmpegStream = ffmpeg(tempFile)
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
        if (tempFile && fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
          console.log(`🗑️ Temp file deleted`);
        }
      })
      .on('error', (err) => {
        console.error(`❌ FFmpeg error: ${err.message}`);
        // Удаляем временный файл при ошибке
        if (tempFile && fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
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
    
    // Удаляем временный файл при ошибке
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to download audio',
        message: error.message
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 AETHEL Backend running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`🎵 Ready to process audio downloads!`);
});
