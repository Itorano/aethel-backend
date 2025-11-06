const express = require('express');
const cors = require('cors');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execPromise = promisify(exec);
const execFilePromise = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const YT_DLP_PATH = path.join(__dirname, 'yt-dlp');

// ИСПРАВЛЕНИЕ: Используем массив вместо строки для избежания проблем с экранированием
async function executeYtDlp(args) {
  try {
    const { stdout, stderr } = await execFilePromise(YT_DLP_PATH, args);
    return { stdout, stderr, success: true };
  } catch (error) {
    return { stdout: '', stderr: error.message, success: false, error };
  }
}

// Получение информации о видео
app.get('/api/audio-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    console.log(`📊 Getting info for: ${videoId}`);

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const args = [
      fs.existsSync(cookiesPath) ? '--cookies' : '--no-cookies',
    ];
    
    if (fs.existsSync(cookiesPath)) {
      args.push(cookiesPath);
    }

    // ИСПРАВЛЕНИЕ: Браузерные заголовки как отдельные элементы массива
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

    console.log(`🔄 Executing yt-dlp with proper escaping...`);
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

    res.json({
      videoId: videoId,
      title: metadata.title,
      duration: metadata.duration || 0,
      audioSize: (bestAudio.filesize || bestAudio.filesize_approx || 0),
      bitrate: bestAudio.abr || 128,
      format: 'm4a'
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

// Скачивание с retry
async function downloadWithRetry(videoUrl, tempPrefix, maxRetries = 3) {
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Download attempt ${attempt}/${maxRetries}...`);
      
      const args = [
        fs.existsSync(cookiesPath) ? '--cookies' : '--no-cookies',
      ];
      
      if (fs.existsSync(cookiesPath)) {
        args.push(cookiesPath);
      }

      // ИСПРАВЛЕНИЕ: Все параметры как отдельные элементы массива
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
      const { success, stderr } = await executeYtDlp(args);
      
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

app.get('/api/download-audio/:videoId', async (req, res) => {
  let tempFile = null;
  
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    console.log(`📥 Downloading audio for: ${videoId}`);

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempPrefix = path.join(tempDir, `${videoId}_${Date.now()}`);

    await downloadWithRetry(videoUrl, tempPrefix, 3);

    const files = fs.readdirSync(tempDir).filter(f => f.startsWith(path.basename(tempPrefix)));
    
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
  }
});

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

app.listen(PORT, () => {
  cleanupTempFiles();
  console.log(`🚀 AETHEL Backend running on port ${PORT}`);
  console.log(`✅ Using execFile (proper escaping)`);
});
