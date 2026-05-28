// ── wttr.in 免费天气接口（无需 API Key） ──
// GET https://wttr.in/{city}?format=j1 返回 JSON

const axios = require('axios');

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟

/**
 * 获取天气
 * @param {string} city - 城市名，如 "北京"、"Shanghai"
 * @returns {Promise<{city, condition, temp, feelsLike, humidity, wind, description}>}
 */
async function fetchWeather(city = '北京') {
  const key = city.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { ...cached.data, cached: true };
  }

  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;

  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'curl/8.0' },
    timeout: 8000,
  });

  const cur = data.current_condition?.[0];
  if (!cur) throw new Error('wttr.in 返回数据异常');

  const zhDesc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '';

  const result = {
    city: city,
    condition: zhDesc,
    temp: `${cur.temp_C}°C`,
    feelsLike: `${cur.FeelsLikeC}°C`,
    humidity: `${cur.humidity}%`,
    wind: `${cur.windspeedKmph}km/h ${cur.winddir16Point}`,
    uvIndex: cur.uvIndex,
    visibility: `${cur.visibility}km`,
  };

  cache.set(key, { data: result, ts: Date.now() });
  return result;
}

module.exports = { fetchWeather };
