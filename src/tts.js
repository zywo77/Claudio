// ── Edge TTS 声音管线 ──
// 免费，无需 API Key，使用微软 Edge 的公共 TTS WebSocket
// 支持 WordBoundary 事件，可精确同步逐字高亮

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VOICE = process.env.TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'tts');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * 合成语音 + 逐字时间戳
 * @param {string} text - 待合成文本
 * @returns {Promise<{ audioBase64: string, words: Array<{text, startMs, endMs}> }>}
 */
async function generate(text) {
  const hash = cacheKey(text);
  const audioPath = path.join(CACHE_DIR, `${hash}.mp3`);
  const metaPath = path.join(CACHE_DIR, `${hash}.json`);

  // 缓存命中
  if (fs.existsSync(audioPath) && fs.existsSync(metaPath)) {
    const audioBuffer = fs.readFileSync(audioPath);
    if (audioBuffer.length > 0) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      return { audioBase64: audioBuffer.toString('base64'), words: meta.words };
    }
  }

  // 每次请求创建新实例，避免 WebSocket 连接过期
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: true,
  });

  const { audioStream, metadataStream } = tts.toStream(text);
  const words = [];
  const chunks = [];

  if (metadataStream) {
    metadataStream.on('data', (chunk) => {
      try {
        const parsed = JSON.parse(chunk.toString());
        const entries = parsed.Metadata || [];
        for (const entry of entries) {
          const bt = entry.Data?.text?.BoundaryType;
          if (bt === 'WordBoundary') {
            words.push({
              text: entry.Data.text.Text || '',
              startMs: (entry.Data.Offset || 0) / 10000,
              endMs: ((entry.Data.Offset || 0) + (entry.Data.Duration || 0)) / 10000,
            });
          }
        }
      } catch {}
    });
  }

  audioStream.on('data', (chunk) => {
    chunks.push(chunk);
  });

  await new Promise((resolve, reject) => {
    audioStream.on('end', resolve);
    audioStream.on('error', reject);
  });

  // 关闭 WebSocket 连接
  tts.close();

  const audioBuffer = Buffer.concat(chunks);

  // 写入缓存
  fs.writeFileSync(audioPath, audioBuffer);
  fs.writeFileSync(metaPath, JSON.stringify({ words }));

  return {
    audioBase64: audioBuffer.toString('base64'),
    words,
  };
}

module.exports = { generate };
