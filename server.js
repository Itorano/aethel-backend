const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Главная страница
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AETHEL Audio Backend',
    version: '2.0.0',
    endpoints: [
      'GET /api/audio-info/:videoId',
      'GET /api/download-audio/:videoId'
    ]
  });
});

// Получение информации о видео и аудио
app.get('/api/audio-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    console.log(`📊 Getting info for: ${videoId}`);

    const info = await ytdl.getInfo(videoId);
    
    // Получаем форматы
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    const videoFormats = ytdl.filterFormats(info.formats, 'videoonly');
    
    if (audioFormats.length === 0) {
      return res.status(404).json({ error: 'No audio formats found' });
    }

    // Находим лучший аудиоформат
    const bestAudio = audioFormats.reduce((best, format) => {
      const bestBitrate = best.audioBitrate || 0;
      const currentBitrate = format.audioBitrate || 0;
      return currentBitrate > bestBitrate ? format : best;
    });

    // Находим размер видео (самое качественное)
    const bestVideo = videoFormats.length > 0 
      ? videoFormats.reduce((best, format) => {
          const bestSize = parseInt(best.contentLength) || 0;
          const currentSize = parseInt(format.contentLength) || 0;
          return currentSize > bestSize ? format : best;
        })
      : null;

    const audioSize = parseInt(bestAudio.contentLength) || 0;
    const videoSize = bestVideo ? parseInt(bestVideo.contentLength) || 0 : 0;

    // Оценка размера после конвертации (AAC ~70-80% от оригинала)
    const estimatedAudioSize = Math.floor(audioSize * 0.75);

    res.json({
      videoId: videoId,
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds),
      videoSize: videoSize > 0 ? videoSize : audioSize * 3, // Примерная оценка
      audioSize: estimatedAudioSize,
      bitrate: bestAudio.audioBitrate || 128,
      format: 'm4a',
      quality: bestAudio.audioQuality || 'medium'
    });

    console.log(`✅ Info retrieved: ${info.videoDetails.title}`);
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
  try {
    const { videoId } = req.params;
    console.log(`📥 Downloading audio for: ${videoId}`);

    const info = await ytdl.getInfo(videoId);
    const title = info.videoDetails.title.replace(/[^\w\s-]/g, '');
    
    // Настройки заголовков для скачивания
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.m4a"`);

    // Получаем лучший аудиопоток
    const audioStream = ytdl(videoId, {
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    // Конвертируем в AAC (M4A) с хорошим качеством
    ffmpeg(audioStream)
      .audioBitrate(128) // Оптимальный битрейт для качества/размера
      .audioCodec('aac')
      .audioChannels(2)
      .format('mp4') // M4A контейнер
      .on('start', (commandLine) => {
        console.log(`🎵 FFmpeg process started: ${commandLine}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`⏳ Processing: ${Math.floor(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log(`✅ Audio conversion completed: ${videoId}`);
      })
      .on('error', (err) => {
        console.error(`❌ FFmpeg error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Conversion failed', message: err.message });
        }
      })
      .pipe(res, { end: true });

  } catch (error) {
    console.error('❌ Download error:', error.message);
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
