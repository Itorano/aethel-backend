const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFilePromise = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const YT_DLP_PATH = path.join(__dirname, 'yt-dlp');

// === СИСТЕМА ОЧЕРЕДЕЙ ===
class DownloadQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentJob = null;
  }

  add(job) {
    this.queue.push(job);
    console.log(`➕ Added to queue: ${job.videoId} (Queue length: ${this.queue.length})`);
    this.processNext();
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    this.currentJob = this.queue.shift();
    
    console.log(`\n🔄 Processing: ${this.currentJob.videoId}`);
    console.log(`📊 Queue remaining: ${this.queue.length}`);

    try {
      await this.currentJob.execute();
      console.log(`✅ Completed: ${this.currentJob.videoId}`);
    } catch (error) {
      console.error(`❌ Failed: ${this.currentJob.videoId}`, error.message);
      this.currentJob.reject(error);
    } finally {
      this.currentJob = null;
      this.processing = false;
      this.processNext(); // Обработать следующий
    }
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentJob: this.currentJob ? this.currentJob.videoId : null
    };
  }
}

const downloadQueue = new DownloadQueue();

// === ПРОВЕРКА YT-DLP ===
async function checkYtDlp() {
  try {
    if (!fs.existsSync(YT_DLP_PATH)) {
      console.log('📥 Downloading yt-dlp binary...');
      const { exec } = require('child_process');
      const execPromise = promisify(exec);
      await execPromise(`wget -O ${YT_DLP_PATH} https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`);
      await execPromise(`chmod 755 ${YT_DLP_PATH}`);
      console.log('✅ yt-dlp downloaded and made executable!');
    }

    const { stdout } = await execFilePromise(YT_DLP_PATH, ['--version']);
    console.log(`✅ yt-dlp version: ${stdout.trim()}`);

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
      console.log('✅ cookies.txt found');
    } else {
      console.log('⚠️ cookies.txt not found - using browser headers');
    }

    return true;
  } catch (error) {
    console.error('❌ Failed to setup yt-dlp:', error.message);
    return false;
  }
}

// === ГЛАВНАЯ СТРАНИЦА ===
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AETHEL Audio Backend',
    version: '3.0.0',
    queue: downloadQueue.getStatus(),
    endpoints: [
      'GET /api/audio-info/:videoId',
      'GET /api/download-audio/:videoId',
      'GET /api/queue-status'
    ]
  });
});

// === СТАТУС ОЧЕРЕДИ ===
app.get('/api/queue-status', (req, res) => {
  res.json(downloadQueue.getStatus());
});

async function executeYtDlp(args) {
  try {
    const { stdout, stderr } = await execFilePromise(YT_DLP_PATH, args, {
      maxBuffer: 10 * 1024 * 1024
    });
    return { stdout, stderr, success: true };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      success: false,
      error
    };
  }
}

// === ПОЛУЧЕНИЕ ИНФОРМАЦИИ (БЕЗ ОЧЕРЕДИ) ===
app.get('/api/audio-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`📊 Getting info for: ${videoId}`);

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const args = [];

    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }

    args.push(
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header',
      'Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8',
      '--add-header',
      'Accept: */*',
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      '--socket-timeout',
      '30',
      videoUrl
    );

    console.log(`🔄 Executing yt-dlp...`);
    const { stdout, success, stderr } = await executeYtDlp(args);

    if (!success) {
      throw new Error(stderr);
    }

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

// === СКАЧИВАНИЕ С RETRY ===
async function downloadWithRetry(videoUrl, tempPrefix, maxRetries = 3) {
  const cookiesPath = path.join(__dirname, 'cookies.txt');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Download attempt ${attempt}/${maxRetries}...`);
      const args = [];

      if (fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
      }

      args.push(
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--add-header',
        'Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8',
        '--add-header',
        'Accept: */*',
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'm4a',
        '--audio-quality', '128K',
        '-o', `${tempPrefix}.%(ext)s`,
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
        videoUrl
      );

      console.log(`🎵 Executing download...`);
      const { success, stderr } = await execFilePromise(YT_DLP_PATH, args, {
        maxBuffer: 200 * 1024 * 1024,
        timeout: 600000
      }).then(() => ({ success: true, stderr: '' }))
        .catch(err => ({ success: false, stderr: err.message }));

      if (success) {
        console.log(`✅ Download successful on attempt ${attempt}`);
        return true;
      }

      console.error(`⚠️ Attempt ${attempt} failed: ${stderr}`);

      if (attempt < maxRetries) {
        const delaySeconds = attempt * 5;
        console.log(`⏳ Waiting ${delaySeconds}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
      }

    } catch (error) {
      console.error(`⚠️ Error on attempt ${attempt}: ${error.message}`);
    }
  }

  throw new Error(`Download failed after ${maxRetries} attempts`);
}

// === СКАЧИВАНИЕ АУДИО (С ОЧЕРЕДЬЮ) ===
app.get('/api/download-audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`📥 Download request for: ${videoId}`);

  // Создаем задачу для очереди
  const job = {
    videoId,
    execute: async function() {
      return new Promise(async (resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;

        let tempFile = null;

        try {
          console.log(`📥 Starting download: ${videoId}`);

          const tempDir = path.join(__dirname, 'temp');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          const tempPrefix = path.join(tempDir, `${videoId}_${Date.now()}`);

          // СКАЧИВАНИЕ + КОНВЕРТАЦИЯ (блокирующая операция)
          await downloadWithRetry(videoUrl, tempPrefix, 3);

          const files = fs.readdirSync(tempDir).filter(f => 
            f.startsWith(path.basename(tempPrefix))
          );

          if (files.length === 0) {
            throw new Error('Download failed - no output file created');
          }

          tempFile = path.join(tempDir, files[0]);
          const stats = fs.statSync(tempFile);

          console.log(`✅ Downloaded: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);

          if (stats.size === 0) {
            fs.unlinkSync(tempFile);
            throw new Error('Downloaded file is empty');
          }

          // ПЕРЕДАЧА КЛИЕНТУ (параллельно со следующей задачей)
          res.setHeader('Content-Type', 'audio/mp4');
          res.setHeader('Content-Disposition', `attachment; filename="${videoId}.m4a"`);
          res.setHeader('Content-Length', stats.size);

          const fileStream = fs.createReadStream(tempFile);
          fileStream.pipe(res);

          fileStream.on('end', () => {
            console.log(`✅ Transfer completed: ${videoId}`);
            try {
              fs.unlinkSync(tempFile);
              console.log(`🗑️ Temp file deleted`);
            } catch (e) {
              console.error('Error deleting temp file:', e.message);
            }
            resolve();
          });

          fileStream.on('error', (err) => {
            console.error(`❌ Stream error: ${err.message}`);
            try {
              if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
              }
            } catch (e) {}
            reject(err);
          });

        } catch (error) {
          console.error('❌ Download error:', error.message);
          
          try {
            if (tempFile && fs.existsSync(tempFile)) {
              fs.unlinkSync(tempFile);
            }
          } catch (e) {}

          if (!res.headersSent) {
            res.status(500).json({
              error: 'Failed to download audio',
              message: error.message
            });
          }
          
          reject(error);
        }
      });
    }
  };

  // Добавляем в очередь
  downloadQueue.add(job);
});

// === ОЧИСТКА ВРЕМЕННЫХ ФАЙЛОВ ===
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

// === ЗАПУСК СЕРВЕРА ===
checkYtDlp().then((success) => {
  if (!success) {
    console.error('❌ Cannot start server without yt-dlp');
    process.exit(1);
  }

  cleanupTempFiles();

  app.listen(PORT, () => {
    console.log(`🚀 AETHEL Backend running on port ${PORT}`);
    console.log(`📍 https://aethel-backend.onrender.com`);
    console.log(`✅ yt-dlp ready`);
    console.log(`✅ Download queue initialized`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
