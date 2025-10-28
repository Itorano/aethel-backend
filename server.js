const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const TMP_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// Utility: удаляет временные файлы старше 10 минут каждые 5 мин
setInterval(() => {
  const now = Date.now();
  fs.readdir(TMP_DIR, (err, files) => {
    if (err) return;
    for (const file of files) {
      const filePath = path.join(TMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (!err && now - stats.mtimeMs > 10 * 60 * 1000) {
          fs.unlink(filePath, () => {});
        }
      });
    }
  });
}, 5 * 60 * 1000);

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Audio Extractor', version: '2.0.0' });
});

// Получить метаданные (размер видео, длительность, ожидаемый размер аудио)
app.get('/api/info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const info = await ytdl.getInfo(videoId);

    const format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
    const videoSize = format.contentLength ? parseInt(format.contentLength) : 0;
    const durationSec = parseInt(info.videoDetails.lengthSeconds || '0');
    const expectedAudioSize = Math.round((128 * 1000 / 8) * durationSec); // mp3 128kbps

    res.json({
      title: info.videoDetails.title,
      videoSize,
      durationSec,
      expectedAudioSize,
      thumbnail: info.videoDetails.thumbnails[0]?.url,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Скачать и конвертировать в аудио, возвращает ссылку
app.post('/api/extract', async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    const outId = uuidv4();
    const videoPath = path.join(TMP_DIR, `${outId}.mp4`);
    const audioPath = path.join(TMP_DIR, `${outId}.mp3`);

    // Скачиваем видео
    const videoStream = ytdl(videoId, { quality: 'highestvideo' });
    const writeStream = fs.createWriteStream(videoPath);
    videoStream.pipe(writeStream);

    writeStream.on('finish', () => {
      // Конвертация в mp3 через ffmpeg
      ffmpeg(videoPath)
        .setFfmpegPath(ffmpegPath)
        .output(audioPath)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .on('end', () => {
          // После конвертации удаляем видео
          fs.unlink(videoPath, () => {});
          // Отдаем ссылку на аудио
          res.json({ audioUrl: `/audio/${outId}.mp3` });
        })
        .on('error', (err) => {
          fs.unlink(videoPath, () => {});
          res.status(500).json({ error: 'FFmpeg error: ' + err.message });
        })
        .run();
    });

    writeStream.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Отдача готовых аудиофайлов
app.use('/audio', express.static(TMP_DIR));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
