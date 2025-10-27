const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core'); // Измените эту строку

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AETHEL Audio Backend',
    version: '1.0.0'
  });
});

app.get('/api/audio-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    console.log(`Getting info for: ${videoId}`);

    const info = await ytdl.getInfo(videoId);

    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');

    if (audioFormats.length === 0) {
      return res.status(404).json({ error: 'No audio formats found' });
    }

    const bestAudio = audioFormats.reduce((best, format) => {
      const bestBitrate = best.audioBitrate || 0;
      const currentBitrate = format.audioBitrate || 0;
      return currentBitrate > bestBitrate ? format : best;
    });

    res.json({
      videoId: videoId,
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds),
      url: bestAudio.url,
      size: parseInt(bestAudio.contentLength) || 0,
      bitrate: bestAudio.audioBitrate || 128,
      format: bestAudio.container || 'audio',
      quality: bestAudio.audioQuality || 'medium'
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      error: 'Failed to get audio info',
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 AETHEL Backend running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
});
