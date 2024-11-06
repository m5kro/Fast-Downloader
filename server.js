const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const port = 3000;

// Serve main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Set up WebSocket server
const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

const wss = new WebSocket.Server({ server });

// Broadcast log messages to all connected clients
function broadcastLog(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Format bytes into KB/s, MB/s, or B/s if your internet is real bad
function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  } else if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`;
  } else {
    return `${bytesPerSecond.toFixed(2)} B/s`;
  }
}

// Calculate MD5 checksum of downloaded file
function calculateMD5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

// Download the file with progress logs, speed updates, and checksum validation
async function downloadFile(url, numChunks, savePath, expectedChecksum = null) {
  const { headers } = await new Promise((resolve, reject) => {
    https.get(url, { method: 'HEAD' }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch file headers. Status code: ${response.statusCode}`));
      } else {
        resolve(response);
      }
    });
  });

  const contentLength = parseInt(headers['content-length'], 10);
  if (isNaN(contentLength)) {
    throw new Error('Failed to retrieve content length');
  }

  broadcastLog({ type: 'log', message: `Total file size: ${contentLength} bytes` });
  
  const chunkSize = Math.ceil(contentLength / numChunks);
  const chunkPromises = [];

  let downloadedBytes = 0;
  const startTime = Date.now();

  // Calculate and broadcast speed every second
  const speedInterval = setInterval(() => {
    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = downloadedBytes / elapsedTime;
    const formattedSpeed = formatSpeed(speed);
    broadcastLog({ type: 'speed', speed: formattedSpeed });
  }, 1000);

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize - 1, contentLength - 1);
    broadcastLog({ type: 'log', message: `Starting download of chunk ${i + 1} (bytes ${start}-${end})` });
    chunkPromises.push(downloadChunk(url, start, end, i + 1, chunkSize, (chunkDownloaded) => {
      downloadedBytes += chunkDownloaded;
    }));
  }

  const chunkPaths = await Promise.all(chunkPromises);

  clearInterval(speedInterval);
  broadcastLog({ type: 'log', message: 'Combining chunks...' });

  // Combine all chunks into final file
  const output = fs.createWriteStream(savePath);
  for (const chunkPath of chunkPaths) {
    await new Promise((resolve, reject) => {
      const chunkStream = fs.createReadStream(chunkPath);
      chunkStream.pipe(output, { end: false });
      chunkStream.on('end', () => {
        fs.unlinkSync(chunkPath); // Delete the chunk files
        resolve();
      });
      chunkStream.on('error', reject);
    });
  }
  output.end();

  broadcastLog({ type: 'log', message: `Download completed and saved to ${savePath}` });

  // If an expected checksum is provided, validate it
  if (expectedChecksum) {
    broadcastLog({ type: 'log', message: 'Calculating MD5 checksum...' });
    const actualChecksum = await calculateMD5(savePath);
    if (actualChecksum === expectedChecksum.toLowerCase()) {
      broadcastLog({ type: 'log', message: `Checksum verification passed! MD5: ${actualChecksum}` });
    } else {
      broadcastLog({ type: 'log', message: `Checksum verification failed! Expected: ${expectedChecksum}, Got: ${actualChecksum}` });
    }
  }
}

// Download a chunk with progress tracking and byte updates
function downloadChunk(url, start, end, chunkNumber, chunkSize, onChunkDownloaded) {
  return new Promise((resolve, reject) => {
    const options = { headers: { Range: `bytes=${start}-${end}` } };
    https.get(url, options, (response) => {
      if (response.statusCode !== 206) {
        reject(new Error(`Unexpected status code ${response.statusCode} for chunk ${chunkNumber}`));
        return;
      }

      const chunkPath = path.join(__dirname, `chunk_${chunkNumber}`);
      const fileStream = fs.createWriteStream(chunkPath);

      let downloadedBytes = 0;
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        onChunkDownloaded(chunk.length); // Update the main downloadedBytes counter
        const progress = ((downloadedBytes / chunkSize) * 100).toFixed(2);
        broadcastLog({ type: 'progress', chunk: chunkNumber, progress });
      });

      response.pipe(fileStream);
      response.on('end', () => {
        broadcastLog({ type: 'log', message: `Chunk ${chunkNumber} downloaded.` });
        resolve(chunkPath);
      });

      response.on('error', (err) => {
        reject(err);
      });
    });
  });
}

app.get('/start-download', (req, res) => {
  const { fileUrl, savePath, chunks, checksum } = req.query;
  const numChunks = parseInt(chunks, 10) || 4;
  res.send('Download started! Check logs for updates.');

  // Start the download
  downloadFile(fileUrl, numChunks, savePath, checksum)
    .catch((error) => {
      broadcastLog({ type: 'log', message: `Error: ${error.message}` });
    });
});
